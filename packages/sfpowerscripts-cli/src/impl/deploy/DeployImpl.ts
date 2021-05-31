import ArtifactFilePathFetcher, {
  ArtifactFilePaths,
} from "@dxatscale/sfpowerscripts.core/lib/artifacts/ArtifactFilePathFetcher";
import PackageMetadata from "@dxatscale/sfpowerscripts.core/lib/PackageMetadata";
import SFPStatsSender from "@dxatscale/sfpowerscripts.core/lib/utils/SFPStatsSender";
import InstallUnlockedPackageImpl from "@dxatscale/sfpowerscripts.core/lib/sfpcommands/package/InstallUnlockedPackageImpl";
import InstallSourcePackageImpl from "@dxatscale/sfpowerscripts.core/lib/sfpcommands/package/InstallSourcePackageImpl";
import InstallDataPackageImpl from "@dxatscale/sfpowerscripts.core/lib/sfpcommands/package/InstallDataPackageImpl";
import ArtifactInstallationStatusChecker from "@dxatscale/sfpowerscripts.core/lib/artifacts/ArtifactInstallationStatusChecker"
import InstalledAritfactsFetcher from "@dxatscale/sfpowerscripts.core/lib/artifacts/InstalledAritfactsFetcher"
import OrgDetails from "@dxatscale/sfpowerscripts.core/lib/org/OrgDetails";
import ArtifactInquirer from "@dxatscale/sfpowerscripts.core/lib/artifacts/ArtifactInquirer";

import fs = require("fs");
import path = require("path");
import {
  PackageInstallationResult,
  PackageInstallationStatus,
} from "@dxatscale/sfpowerscripts.core/lib/package/PackageInstallationResult";
import SFPLogger, {
  LoggerLevel,
} from "@dxatscale/sfpowerscripts.core/lib/utils/SFPLogger";
import { EOL } from "os";
import { Stage } from "../Stage";
import ProjectConfig from "@dxatscale/sfpowerscripts.core/lib/project/ProjectConfig";
import TriggerApexTests from "@dxatscale/sfpowerscripts.core/lib/sfpcommands/apextest/TriggerApexTests";
import SFPPackage from "@dxatscale/sfpowerscripts.core/lib/package/SFPPackage";
import { CoverageOptions } from "@dxatscale/sfpowerscripts.core/lib/package/IndividualClassCoverage";
import { RunAllTestsInPackageOptions } from "@dxatscale/sfpowerscripts.core/lib/sfpcommands/apextest/ExtendedTestOptions";
import { TestOptions } from "@dxatscale/sfpowerscripts.core/lib/sfdxwrappers/TestOptions";
import semver = require("semver");
const Table = require("cli-table");
const retry = require("async-retry");

export enum DeploymentMode {
  NORMAL,
  SOURCEPACKAGES,
}

export interface DeployProps {
  targetUsername: string;
  artifactDir: string;
  deploymentMode: DeploymentMode;
  isTestsToBeTriggered: boolean;
  skipIfPackageInstalled: boolean;
  logsGroupSymbol?: string[];
  coverageThreshold?: number;
  waitTime: number;
  tags?: any;
  packageLogger?: any;
  currentStage?: Stage;
  baselineOrg?: string;
  isCheckIfPackagesPromoted?: boolean;
  isDryRun?: boolean;
  isRetryOnFailure?: boolean;
}

export default class DeployImpl {
  constructor(private props: DeployProps) { }
  // TODO: Refactor to use exception pattern
  public async exec(): Promise<{
    deployed: string[];
    failed: string[];
    testFailure: string;
    error: any;
  }> {
    let orgDetails = await OrgDetails.getOrgDetails(this.props.targetUsername);
    let deployed: string[] = [];
    let failed: string[] = [];
    let testFailure: string;
    try {
      let artifacts = ArtifactFilePathFetcher.fetchArtifactFilePaths(
        this.props.artifactDir
      );

      if (artifacts.length === 0)
        throw new Error(
          `No artifacts to deploy found in ${this.props.artifactDir}`
        );

      let artifactInquirer: ArtifactInquirer = new ArtifactInquirer(
        artifacts,
        this.props.packageLogger
      );
      let packageManifest = artifactInquirer.latestPackageManifestFromArtifacts

      if (packageManifest == null) {
        // If unable to find latest package manfest in artifacts, use package manifest in project directory
        packageManifest = ProjectConfig.getSFDXPackageManifest(null);
      }


      let packagesToPackageInfo = this.getPackagesToPackageInfo(artifacts);

      let queue: any[] = this.getPackagesToDeploy(
        packageManifest,
        packagesToPackageInfo
      );

      if (this.props.skipIfPackageInstalled) {
        //Filter the queue based on what is deployed in the target org
        let isBaselinOrgModeActivated: boolean;
        if (this.props.baselineOrg) {
          isBaselinOrgModeActivated = true;
        }
        else {
          isBaselinOrgModeActivated = false;
          this.props.baselineOrg = this.props.targetUsername; //Change baseline to the target one itself
        }

        let filteredDeploymentQueue = await this.filterByPackagesInstalledInTheOrg(packageManifest, queue, packagesToPackageInfo, this.props.baselineOrg);
        this.printArtifactVersionsWhenSkipped(queue, packagesToPackageInfo, isBaselinOrgModeActivated);
        queue = filteredDeploymentQueue;
      }
      else {
        this.printArtifactVersions(queue, packagesToPackageInfo);
      }

      if (!orgDetails.IsSandbox) {
        if (this.props.isCheckIfPackagesPromoted)
          this.checkIfPackagesPromoted(queue, packagesToPackageInfo);
      }


      SFPStatsSender.logGauge(
        "deploy.scheduled.packages",
        queue.length,
        this.props.tags
      );


      for (let i = 0; i < queue.length; i++) {
        let packageInfo = packagesToPackageInfo[queue[i].package];
        let packageMetadata: PackageMetadata = packageInfo.packageMetadata;

        let packageType: string = packageMetadata.package_type;

        let pkgDescriptor = ProjectConfig.getPackageDescriptorFromConfig(
          queue[i].package,
          packageManifest
        );

        this.printOpenLoggingGroup("Installing ", queue[i].package);
        this.displayHeader(packageMetadata, pkgDescriptor, queue[i].package);

        let packageInstallationResult = await retry(
          async (bail,count) => {

            try {
              
              this.displayRetryHeader(this.props.isRetryOnFailure,count);

              let installPackageResult = await this.installPackage(
                packageType,
                queue[i].package,
                this.props.targetUsername,
                packageInfo.sourceDirectory,
                packageMetadata,
                queue[i].skipTesting,
                this.props.waitTime.toString(),
                pkgDescriptor,
                false
              );
              if (this.props.isRetryOnFailure && installPackageResult.result === PackageInstallationStatus.Failed && count ==1) {
               {
                  throw new Error(installPackageResult.message)}
               }
              else
                return installPackageResult;
            } catch (error) {
              if (!this.props.isRetryOnFailure) // Any other exception, in regular cases dont retry, just bail out
                 { 
                  let failedPackageInstallationResult: PackageInstallationResult = {
                      result : PackageInstallationStatus.Failed,
                       message:error
                  }
                   return failedPackageInstallationResult;
                 }
              else { 
                console.log('error.status: '+error.status);
                console.log('error.message: '+error.message);
                console.log('error.stderr: '+error.stderr);
                console.log('error.stdout: '+error.stdout);
                throw (error);
              }
            }

          }, { retries: 1, minTimeout: 2000 });

       
        if (
          packageInstallationResult.result ===
          PackageInstallationStatus.Succeeded
        ) {
          deployed.push(queue[i].package);
          this.printClosingLoggingGroup();
        } else if (
          packageInstallationResult.result === PackageInstallationStatus.Skipped
        ) {
          this.printClosingLoggingGroup();
          continue;
        } else if (
          packageInstallationResult.result === PackageInstallationStatus.Failed
        ) {
          failed = queue.slice(i).map((pkg) => pkg.package);

          console.log('packageInstallationResult.message: '+packageInstallationResult.message);
          console.log('stringified message: '+JSON.stringify(packageInstallationResult.message));

          throw new Error(packageInstallationResult.message);
        }

        if (this.props.isTestsToBeTriggered) {
          if (packageMetadata.isApexFound) {
            if (!queue[i].skipTesting) {
              this.printOpenLoggingGroup("Trigger Tests for ", queue[i].package);

              let testResult;
              try {
                testResult = await this.triggerApexTests(
                  queue[i].package,
                  this.props.targetUsername,
                  queue[i].skipCoverageValidation,
                  this.props.coverageThreshold
                );
              } catch (error) {
                //Print Any errors, Report that as execution failed for reporting
                console.log(error);
                testResult = {
                  result: false,
                  message: "Test Execution failed"
                };
              }

              if (!testResult.result) {
                testFailure = queue[i].package;

                if (i !== queue.length - 1)
                  failed = queue.slice(i + 1).map((pkg) => pkg.package);

                throw new Error(testResult.message);
              } else {
                SFPLogger.log(
                  testResult.message,
                  null,
                  this.props.packageLogger,
                  LoggerLevel.INFO
                );

                this.printClosingLoggingGroup();
              }
            } else {
              SFPLogger.log(
                `Skipping testing of ${queue[i].package}\n`,
                null,
                this.props.packageLogger,
                LoggerLevel.INFO
              );
            }
          }
        }
      }

      return {
        deployed: deployed,
        failed: failed,
        testFailure: testFailure,
        error: null,
      };
    } catch (err) {
      SFPLogger.log(err, null, this.props.packageLogger, LoggerLevel.INFO);

      return {
        deployed: deployed,
        failed: failed,
        testFailure: testFailure,
        error: err,
      };
    }
  }


  private displayRetryHeader(isRetryOnFailure:boolean,count:number) {
    if (isRetryOnFailure && count>1) {
      SFPLogger.log(
        `-------------------------------------------------------------------------------${EOL}`, null,
        this.props.packageLogger,
        LoggerLevel.INFO
      );

      SFPLogger.log(
        `Retrying On Failure`, `Attempt: ${count}`,
        this.props.packageLogger,
        LoggerLevel.INFO
      );
      SFPLogger.log(
        `-------------------------------------------------------------------------------${EOL}`, null,
        this.props.packageLogger,
        LoggerLevel.INFO
      );
    }
  }

  private displayHeader(packageMetadata: PackageMetadata, pkgDescriptor: any, pkg: string) {
    let isApexFoundMessage: string = packageMetadata.package_type === "unlocked"
      ? ""
      : `Contains Apex Classes/Triggers: ${packageMetadata.isApexFound}${EOL}`;

    let alwaysDeployMessage: string;

    if (this.props.skipIfPackageInstalled) {
      if (pkgDescriptor.alwaysDeploy)
        alwaysDeployMessage = `Always Deploy: True ${EOL}`;

      else
        alwaysDeployMessage = `Always Deploy: False ${EOL}`;
    } else
      alwaysDeployMessage = "";

    SFPLogger.log(
      `-------------------------Installing Package------------------------------------${EOL}` +
      `Name: ${pkg}${EOL}` +
      `Type: ${packageMetadata.package_type}${EOL}` +
      `Version Number: ${packageMetadata.package_version_number}${EOL}` +
      `Metadata Count: ${packageMetadata.metadataCount}${EOL}` +
      isApexFoundMessage +
      alwaysDeployMessage +
      `-------------------------------------------------------------------------------${EOL}`,
      null,
      this.props.packageLogger,
      LoggerLevel.INFO
    );
  }

  private checkIfPackagesPromoted(queue: any[], packagesToPackageInfo: { [p: string]: PackageInfo; }) {
    let unpromotedPackages: string[] = [];
    queue.forEach((pkg) => {
      if (!packagesToPackageInfo[pkg.package].packageMetadata.isPromoted)
        unpromotedPackages.push(pkg.package);
    });

    if (unpromotedPackages.length > 0)
      throw new Error(`Packages must be promoted for deployments to production org: ${unpromotedPackages}`);
  }

  private printArtifactVersionsWhenSkipped(queue: any[], packagesToPackageInfo: { [p: string]: PackageInfo }, isBaselinOrgModeActivated: boolean) {
    this.printOpenLoggingGroup(`Full Deployment Breakdown`);
    let maxTable = new Table({
      head: ["Package", "Incoming Version", isBaselinOrgModeActivated ? "Version in baseline org" : "Version in org", "To be installed?"],
    });

    queue.forEach((pkg) => {
      maxTable.push(
        [pkg.package,
        packagesToPackageInfo[pkg.package].packageMetadata.package_version_number,
        packagesToPackageInfo[pkg.package].versionInstalledInOrg ? packagesToPackageInfo[pkg.package].versionInstalledInOrg : "N/A",
        packagesToPackageInfo[pkg.package].isPackageInstalled ? "No" : "Yes"]
      );
    });
    console.log(maxTable.toString());
    this.printClosingLoggingGroup();

    this.printOpenLoggingGroup(`Packages to be deployed`);
    let minTable = new Table({
      head: ["Package", "Incoming Version", isBaselinOrgModeActivated ? "Version in baseline org" : "Version in org"],
    });

    queue.forEach((pkg) => {
      if (!packagesToPackageInfo[pkg.package].isPackageInstalled)
        minTable.push(
          [pkg.package,
          packagesToPackageInfo[pkg.package].packageMetadata.package_version_number,
          packagesToPackageInfo[pkg.package].versionInstalledInOrg ? packagesToPackageInfo[pkg.package].versionInstalledInOrg : "N/A"]
        );
    });
    console.log(minTable.toString());
    this.printClosingLoggingGroup();
  }

  private printArtifactVersions(queue: any[], packagesToPackageInfo: { [p: string]: PackageInfo }) {
    this.printOpenLoggingGroup(`Packages to be deployed`);
    let table = new Table({
      head: ["Package", "Version to be installed"],
    });

    queue.forEach((pkg) => {
      table.push([pkg.package,
      packagesToPackageInfo[pkg.package].packageMetadata.package_version_number]);
    });
    SFPLogger.log(table.toString(), null, this.props.packageLogger, LoggerLevel.INFO);
    this.printClosingLoggingGroup();
  }

  private async filterByPackagesInstalledInTheOrg(packageManifest: any, queue: any[], packagesToPackageInfo: { [p: string]: PackageInfo }, targetUsername: string): Promise<any[]> {

    const clonedQueue = [];
    queue.forEach(val => clonedQueue.push(Object.assign({}, val)));

    for (var i = queue.length - 1; i >= 0; i--) {
      let packageInfo = packagesToPackageInfo[clonedQueue[i].package];
      let packageMetadata: PackageMetadata = packageInfo.packageMetadata;
      let pkgDescriptor = ProjectConfig.getPackageDescriptorFromConfig(
        clonedQueue[i].package,
        packageManifest
      );
      let packageInstalledInTheOrg = await ArtifactInstallationStatusChecker.checkWhetherPackageIsIntalledInOrg(targetUsername, packageMetadata, false);
      if (packageInstalledInTheOrg.versionNumber)
        packageInfo.versionInstalledInOrg = packageInstalledInTheOrg.versionNumber;
      if (packageInstalledInTheOrg.isInstalled) {
        if (!pkgDescriptor.alwaysDeploy) {
          packageInfo.isPackageInstalled = true;
          clonedQueue.splice(i, 1);
        }
      }
    }

    //Do a reset after this stage, as fetched artifacts are a static var, to reduce roundtrip, but this has side effects
    InstalledAritfactsFetcher.resetFetchedArtifacts();
    return clonedQueue;

  }

  private printOpenLoggingGroup(message: string, pkg?: string) {
    if (this.props.logsGroupSymbol?.[0])
      SFPLogger.log(
        this.props.logsGroupSymbol[0],
        message + (pkg ? pkg : ""),
        this.props.packageLogger,
        LoggerLevel.INFO
      );
  }

  private printClosingLoggingGroup() {
    if (this.props.logsGroupSymbol?.[1])
      SFPLogger.log(
        this.props.logsGroupSymbol[1],
        null,
        this.props.packageLogger,
        LoggerLevel.INFO
      );
  }

  /**
   * Returns map of package name to package info
   * @param artifacts
   */
  private getPackagesToPackageInfo(
    artifacts: ArtifactFilePaths[]
  ): { [p: string]: PackageInfo } {
    let packagesToPackageInfo: { [p: string]: PackageInfo } = {};

    for (let artifact of artifacts) {
      let packageMetadata: PackageMetadata = JSON.parse(
        fs.readFileSync(artifact.packageMetadataFilePath, "utf8")
      );

      if (packagesToPackageInfo[packageMetadata.package_name]) {
        let previousVersionNumber = this.convertBuildNumDotDelimToHyphen(
          packagesToPackageInfo[packageMetadata.package_name].packageMetadata.package_version_number
        );
        let currentVersionNumber = this.convertBuildNumDotDelimToHyphen(
          packageMetadata.package_version_number
        );

        // replace existing packageInfo if package version number is newer
        if (semver.gt(currentVersionNumber, previousVersionNumber)) {
          packagesToPackageInfo[packageMetadata.package_name] = {
            sourceDirectory: artifact.sourceDirectoryPath,
            packageMetadata: packageMetadata,
          };
        }
      } else {
        packagesToPackageInfo[packageMetadata.package_name] = {
          sourceDirectory: artifact.sourceDirectoryPath,
          packageMetadata: packageMetadata,
        };
      }
    }
    return packagesToPackageInfo;
  }

  /**
   * Converts build-number dot delimeter to hyphen
   * If dot delimeter does not exist, returns input
   * @param version
   */
  private convertBuildNumDotDelimToHyphen(version: string) {
    let convertedVersion = version;

    let indexOfBuildNumDelimiter = this.getIndexOfBuildNumDelimeter(version);
    if (version[indexOfBuildNumDelimiter] === ".") {
      convertedVersion =
        version.substring(0, indexOfBuildNumDelimiter) +
        "-" +
        version.substring(indexOfBuildNumDelimiter + 1);
    }
    return convertedVersion;
  }

  /**
   * Get the index of the build-number delimeter
   * Returns null if unable to find index of delimeter
   * @param version
   */
  private getIndexOfBuildNumDelimeter(version: string) {
    let numOfDelimetersTraversed: number = 0;
    for (let i = 0; i < version.length; i++) {
      if (!Number.isInteger(parseInt(version[i], 10))) {
        numOfDelimetersTraversed++
      }
      if (numOfDelimetersTraversed === 3) {
        return i;
      }
    }
    return null;
  }

  /**
   * Decider for which package installation type to run
   */
  private async installPackage(
    packageType: string,
    sfdx_package: string,
    targetUsername: string,
    sourceDirectoryPath: string,
    packageMetadata: PackageMetadata,
    skipTesting: boolean,
    wait_time: string,
    pkgDescriptor: any,
    skipIfPackageInstalled: boolean
  ): Promise<PackageInstallationResult> {
    let packageInstallationResult: PackageInstallationResult;

    if (this.props.deploymentMode == DeploymentMode.NORMAL) {
      if (packageType === "unlocked") {
        packageInstallationResult = await this.installUnlockedPackage(
          targetUsername,
          packageMetadata,
          skipIfPackageInstalled,
          wait_time,
          sourceDirectoryPath
        );
      } else if (packageType === "source") {
        let options = {
          optimizeDeployment: this.isOptimizedDeploymentForSourcePackage(
            pkgDescriptor
          ),
          skipTesting: skipTesting,
        };

        packageInstallationResult = await this.installSourcePackage(
          sfdx_package,
          targetUsername,
          sourceDirectoryPath,
          packageMetadata,
          options,
          skipIfPackageInstalled,
          wait_time
        );
      } else if (packageType === "data") {
        packageInstallationResult = await this.installDataPackage(
          sfdx_package,
          targetUsername,
          sourceDirectoryPath,
          skipIfPackageInstalled,
          packageMetadata
        );
      } else {
        throw new Error(`Unhandled package type ${packageType}`);
      }
    } else if (this.props.deploymentMode == DeploymentMode.SOURCEPACKAGES) {
      if (packageType === "source" || packageType === "unlocked") {
        let options = {
          optimizeDeployment: false,
          skipTesting: true,
        };

        packageInstallationResult = await this.installSourcePackage(
          sfdx_package,
          targetUsername,
          sourceDirectoryPath,
          packageMetadata,
          options,
          skipIfPackageInstalled,
          wait_time
        );
      } else if (packageType === "data") {
        packageInstallationResult = await this.installDataPackage(
          sfdx_package,
          targetUsername,
          sourceDirectoryPath,
          skipIfPackageInstalled,
          packageMetadata
        );
      } else {
        throw new Error(`Unhandled package type ${packageType}`);
      }
    }
    return packageInstallationResult;
  }

  private installUnlockedPackage(
    targetUsername: string,
    packageMetadata: PackageMetadata,
    skip_if_package_installed: boolean,
    wait_time: string,
    sourceDirectoryPath: string
  ): Promise<PackageInstallationResult> {
    let options = {
      installationkey: null,
      apexcompile: "package",
      securitytype: "AdminsOnly",
      upgradetype: "Mixed",
    };

    let installUnlockedPackageImpl: InstallUnlockedPackageImpl = new InstallUnlockedPackageImpl(
      packageMetadata.package_version_id,
      targetUsername,
      options,
      wait_time,
      "10",
      skip_if_package_installed,
      packageMetadata,
      sourceDirectoryPath,
      this.props.packageLogger
    );

    return installUnlockedPackageImpl.exec();
  }

  private installSourcePackage(
    sfdx_package: string,
    targetUsername: string,
    sourceDirectoryPath: string,
    packageMetadata: PackageMetadata,
    options: any,
    skip_if_package_installed: boolean,
    wait_time: string
  ): Promise<PackageInstallationResult> {
    let installSourcePackageImpl: InstallSourcePackageImpl = new InstallSourcePackageImpl(
      sfdx_package,
      targetUsername,
      sourceDirectoryPath,
      options,
      wait_time,
      skip_if_package_installed,
      packageMetadata,
      false,
      this.props.packageLogger,
      this.props.currentStage == "prepare"
        ? path.join(sourceDirectoryPath, "forceignores", ".prepareignore")
        : null
    );

    return installSourcePackageImpl.exec();
  }

  private installDataPackage(
    sfdx_package: string,
    targetUsername: string,
    sourceDirectoryPath: string,
    skip_if_package_installed: boolean,
    packageMetadata: PackageMetadata
  ): Promise<PackageInstallationResult> {
    let installDataPackageImpl: InstallDataPackageImpl = new InstallDataPackageImpl(
      sfdx_package,
      targetUsername,
      sourceDirectoryPath,
      packageMetadata,
      skip_if_package_installed,
      false,
      this.props.packageLogger
    );
    return installDataPackageImpl.exec();
  }

  private async triggerApexTests(
    sfdx_package: string,
    targetUsername: string,
    skipCoverageValidation: boolean,
    coverageThreshold: number
  ): Promise<{
    id: string;
    result: boolean;
    message: string;
  }> {
    let sfPackage: SFPPackage = await SFPPackage.buildPackageFromProjectConfig(
      null,
      sfdx_package,
      null,
      this.props.packageLogger
    );
    let testOptions: TestOptions = new RunAllTestsInPackageOptions(
      sfPackage,
      60,
      ".testresults"
    );
    let testCoverageOptions: CoverageOptions = {
      isIndividualClassCoverageToBeValidated: false,
      isPackageCoverageToBeValidated: !skipCoverageValidation,
      coverageThreshold: coverageThreshold || 75,
    };

    let triggerApexTests: TriggerApexTests = new TriggerApexTests(
      targetUsername,
      testOptions,
      testCoverageOptions,
      null
    );

    return triggerApexTests.exec();
  }

  /**
   * Checks if package should be installed to target username
   * @param packageDescriptor
   */
  private isSkipDeployment(
    packageDescriptor: any,
    targetUsername: string
  ): boolean {
    let skipDeployOnOrgs: string[] = packageDescriptor.skipDeployOnOrgs;
    if (skipDeployOnOrgs) {
      if (!(skipDeployOnOrgs instanceof Array))
        throw new Error(`Property 'skipDeployOnOrgs' must be of type Array`);
      else return skipDeployOnOrgs.includes(targetUsername);
    } else return false;
  }

  // Allow individual packages to use non optimized path
  private isOptimizedDeploymentForSourcePackage(pkgDescriptor: any): boolean {
    if (pkgDescriptor["isOptimizedDeployment"] == null) return true;
    else return pkgDescriptor["isOptimizedDeployment"];
  }

  /**
   * Returns the packages in the project config that have an artifact
   */
  private getPackagesToDeploy(
    packageManifest: any,
    packagesToPackageInfo: { [p: string]: PackageInfo }
  ): any[] {
    let packagesToDeploy: any[];

    let packages = packageManifest["packageDirectories"];

    // Filter package manifest by artifact
    packagesToDeploy = packages.filter((pkg) => {
      return packagesToPackageInfo[pkg.package]
    });

    // Filter out packages that are to be skipped on the target org
    packagesToDeploy = packagesToDeploy.filter(
      (pkg) => !this.isSkipDeployment(pkg, this.props.targetUsername)
    );

    //Ignore packages based on stage
    packagesToDeploy = packagesToDeploy.filter((pkg) => {
      if (
        pkg.ignoreOnStage?.find((stage) => {
          stage = stage.toLowerCase();
          return stage === this.props.currentStage;
        })
      )
        return false;
      else return true;
    });

    if (packagesToDeploy == null || packagesToDeploy.length === 0)
      throw new Error(`No artifacts from project config to be deployed`);
    else return packagesToDeploy;
  }
}

interface PackageInfo {
  sourceDirectory: string;
  packageMetadata: PackageMetadata;
  versionInstalledInOrg?: string
  isPackageInstalled?: boolean;
}

export interface DeploymentResult {
  deployed: string[];
  failed: string[];
  testFailure: string;
  error: any;
}



