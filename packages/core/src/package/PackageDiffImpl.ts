const fs = require("fs");
const path = require("path");
import Git from "../utils/Git";
import IgnoreFiles from "../utils/IgnoreFiles";
import SFPLogger from "../utils/SFPLogger";
import ProjectConfig from "../project/ProjectConfig";
import GitTags from "../utils/GitTags";
import lodash = require("lodash");

export default class PackageDiffImpl {
  public constructor(
    private sfdx_package: string,
    private project_directory: string,
    private config_file_path?: string,
    private packagesToCommits?: {[p: string]: string},
    private pathToReplacementForceIgnore?: string
  ) {}

  public async exec(): Promise<{isToBeBuilt:boolean,reason:string,tag?:string}> {
    let git: Git = new Git(this.project_directory);

    let config_file_path: string = this.config_file_path;

    let projectConfig = ProjectConfig.getSFDXPackageManifest(this.project_directory);
    let pkgDescriptor = ProjectConfig.getPackageDescriptorFromConfig(this.sfdx_package, projectConfig);

    SFPLogger.log(
      `Checking last known tags for ${this.sfdx_package} to determine whether package is to be built...`
    );

    let tag: string;
    if ( this.packagesToCommits != null ) {
      tag = this.getLatestCommitFromMap(this.sfdx_package, this.packagesToCommits);
    } else {
      tag = await this.getLatestTagFromGit(git, this.sfdx_package);
    }

    if (tag) {
      SFPLogger.log(`\nUtilizing tag ${tag} for ${this.sfdx_package}`);

      // Get the list of modified files between the tag and HEAD refs
      let modified_files: string[] = await git.diff([
        `${tag}`,
        `HEAD`,
        `--no-renames`,
        `--name-only`
      ]);

      let packageType: string = ProjectConfig.getPackageType(projectConfig, this.sfdx_package);

      if (packageType !== "Data")
        modified_files = this.applyForceIgnoreToModifiedFiles(modified_files);

      const isUnlockedAndConfigFilePath = packageType === "Unlocked" && config_file_path != null;

      if (isUnlockedAndConfigFilePath)
        SFPLogger.log(`Checking for changes to ${config_file_path}`);

      SFPLogger.log(`Checking for changes in source directory ${path.normalize(pkgDescriptor.path)}`);

      // Check whether the package has been modified

      for (let filename of modified_files) {
        if (isUnlockedAndConfigFilePath) {
          if (
              filename.includes(path.normalize(pkgDescriptor.path)) ||
              filename === config_file_path
          ) {
              SFPLogger.log(`Found change(s) in ${filename}`);
              return {isToBeBuilt:true,reason:`Found change(s) in package/config`,tag:tag};
          }
        } else {
          if (filename.includes(path.normalize(pkgDescriptor.path))) {
            SFPLogger.log(`Found change(s) in ${filename}`);
            return {isToBeBuilt:true,reason:`Found change(s) in package`,tag:tag};
          }
        }
      }

      SFPLogger.log(`Checking for changes to package descriptor in sfdx-project.json`);
      let isPackageDescriptorChanged = await this.isPackageDescriptorChanged(
        git,
        tag,
        pkgDescriptor
      );
      if(isPackageDescriptorChanged)
        return  {isToBeBuilt:true,reason:`Package Descriptor Changed`,tag:tag};
    } else {
      SFPLogger.log(
        `Tag missing for ${this.sfdx_package}...marking package for build anyways`
      );
      return  {isToBeBuilt:true,reason:`Previous version not found`};
    }
  }

  private applyForceIgnoreToModifiedFiles(modified_files: string[]) {
    let forceignorePath: string;
    if (this.pathToReplacementForceIgnore)
      forceignorePath = this.pathToReplacementForceIgnore;
    else if (this.project_directory != null)
      forceignorePath = path.join(this.project_directory, ".forceignore");
    else
      forceignorePath = ".forceignore";

    let ignoreFiles: IgnoreFiles = new IgnoreFiles(
      fs.readFileSync(forceignorePath).toString()
    );

    // Filter the list of modified files with .forceignore
    modified_files = ignoreFiles.filter(modified_files);

    return modified_files;
  }

  private async getLatestTagFromGit(git: Git, sfdx_package: string): Promise<string> {
    const gitTags: GitTags = new GitTags(git, sfdx_package);
    let tags: string[] = await gitTags.listTagsOnBranch();

    SFPLogger.log("Analysing tags:");
    if (tags.length > 10) {
      SFPLogger.log(tags.slice(-10).toString().replace(/,/g, "\n"));
    } else {
      SFPLogger.log(tags.toString().replace(/,/g, "\n"));
    }

    return tags.pop();
  }

  private async isPackageDescriptorChanged(
    git: Git,
    latestTag: string,
    packageDescriptor: any
  ): Promise<boolean> {
    let projectConfigJson: string = await git.show([
      `${latestTag}:sfdx-project.json`,
    ]);
    let projectConfig = JSON.parse(projectConfigJson);

    let packageDescriptorFromLatestTag: string;
    for (let dir of projectConfig["packageDirectories"]) {
      if (this.sfdx_package === dir.package) {
        packageDescriptorFromLatestTag = dir;
      }
    }

    if(!lodash.isEqual(packageDescriptor, packageDescriptorFromLatestTag)) {
      SFPLogger.log(
        `Found change in ${this.sfdx_package} package descriptor`
      );
      return true;
    } else return false;
  }

  private getLatestCommitFromMap(
    sfdx_package: string,
    packagesToCommits: {[p: string]: string}
  ): string {
    if (packagesToCommits[sfdx_package] != null) {
      return packagesToCommits[sfdx_package];
    } else {
      return null;
    }
  }
}
