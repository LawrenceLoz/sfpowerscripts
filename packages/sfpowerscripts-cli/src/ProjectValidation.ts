import ProjectConfig from "@dxatscale/sfpowerscripts.core/lib/project/ProjectConfig";
import Ajv from "ajv"
import path = require("path");
import * as fs from "fs-extra";

export default class ProjectValidation {

  private readonly projectConfig;
  private ajv:Ajv;
  resourcesDir: string;

  constructor(){
    this.projectConfig = ProjectConfig.getSFDXPackageManifest(null);
    this.ajv=new Ajv({allErrors: true});
    this.resourcesDir = path.join(
      __dirname,
      "..",
      "resources",
      "schemas"
    );
  }

 public validateSFDXProjectJSON()
 {
   let schema = fs.readJSONSync(path.join(this.resourcesDir,`sfdx-project.schema.json`), {encoding:'UTF-8'})
   let validator = this.ajv.compile(schema);
   let isSchemaValid = validator(this.projectConfig);
   if(!isSchemaValid)
   {
    let errorMsg: string =`The sfdx-project.json is invalid, Please fix the following errors\n`;

    validator.errors.forEach((error,errorNum) => {
      errorMsg += `\n${errorNum+1}: ${error.instancePath}: ${error.message} ${JSON.stringify(error.params, null, 4)}`;
    });

    throw new Error(errorMsg);
   }
 }


  public validatePackageBuildNumbers() {
    this.projectConfig.packageDirectories.forEach((pkg) => {
      let packageType = ProjectConfig.getPackageType(
        this.projectConfig,
        pkg.package
      );

      let pattern: RegExp = /NEXT$|LATEST$/i;
      if (
        pkg.versionNumber.match(pattern) &&
        (packageType === "Source" || packageType === "Data")
      ) {
        throw new Error('The build-number keywords "NEXT" & "LATEST" are not supported for Source & Data packages. Please use 0 instead');
      }
    });
  }
}
