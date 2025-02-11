import * as fs from "fs-extra";
import path = require("path");
import TriggerApexTestImpl from "../../sfdxwrappers/TriggerApexTestImpl";
import { TestOptions } from "../../sfdxwrappers/TestOptions";
import IndividualClassCoverage, {
  CoverageOptions,
} from "../../package/IndividualClassCoverage";
import { TestReportDisplayer } from "./TestReportDisplayer";
import PackageTestCoverage from "../../package/PackageTestCoverage";
import SFPLogger from "../../utils/SFPLogger";
import { RunAllTestsInPackageOptions } from "./ExtendedTestOptions";
import SFPStatsSender from "../../utils/SFPStatsSender";

export default class TriggerApexTests {
  public constructor(
    private target_org: string,
    private testOptions: TestOptions,
    private coverageOptions: CoverageOptions,
    private project_directory: string,
    private fileLogger?: any
  ) { }

  public async exec(): Promise<{
    id: string;
    result: boolean;
    message: string;
  }> {

    let startTime = Date.now();
    let testExecutionResult: boolean = false;
    let testTotalTime;
    let testsRan;

    try {

      let triggerApexTestImpl: TriggerApexTestImpl = new TriggerApexTestImpl(
        this.target_org,
        this.project_directory,
        this.testOptions
      );

      SFPLogger.log(
        "Executing Command",
        triggerApexTestImpl.getGeneratedSFDXCommandWithParams(),
        this.fileLogger
      );

      let testExecErrorMsg: string;
      try {
        await triggerApexTestImpl.exec(true);
      } catch (err) {
        // catch error so that results can be displayed
        testExecErrorMsg = err.message;
      }

      let id: string;
      let testReport;
      try {
        id = this.getTestId();
        testReport = this.getTestReport(id);
      } catch (err) {
        // catch file parse error and replace with test exec error
        if (testExecErrorMsg)
          throw new Error(testExecErrorMsg);
        else
          throw err;
      }

      let testReportDisplayer = new TestReportDisplayer(
        testReport,
        this.testOptions,
        this.fileLogger
      );



      testTotalTime = testReport.summary.testTotalTime.split(" ")[0];


      if (testReport.summary.outcome == "Failed") {
        testExecutionResult = false;
        testReportDisplayer.printTestResults();

        return {
          result: false,
          id: id,
          message: "Test Execution failed",
        };
      } else {
        let coverageResults = await this.validateForApexCoverage();
        testReportDisplayer.printTestResults();
        testReportDisplayer.printCoverageReport(
          this.coverageOptions.coverageThreshold,
          coverageResults.classesCovered,
          coverageResults.classesWithInvalidCoverage
        );
        testReportDisplayer.printTestSummary(coverageResults.packageTestCoverage);
        testsRan = testReport.summary.testsRan

        if (
          this.coverageOptions.isIndividualClassCoverageToBeValidated ||
          this.coverageOptions.isPackageCoverageToBeValidated
        ) {

          testExecutionResult = coverageResults.result;
          SFPStatsSender.logGauge("apextest.testcoverage", coverageResults.packageTestCoverage, {
            package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null
          });

          return {
            result: coverageResults.result,
            id: id,
            message: coverageResults.message,
          };

        } else {
          testExecutionResult = true;
          SFPStatsSender.logGauge("apextest.testcoverage", testReport.summary.testRunCoverage, {
            package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null
          });
          return {
            result: true,
            id: id,
            message: `Test execution succesfully completed`,
          };
        }
      }
    }
    finally {
      let elapsedTime = Date.now() - startTime;

      if (testExecutionResult)
        SFPStatsSender.logGauge("apextest.tests.ran", testsRan, {
          test_result: String(testExecutionResult),
          package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null,
          type: this.testOptions.testLevel,
          target_org: this.target_org,
        });


      SFPStatsSender.logElapsedTime("apextest.testtotal.time", testTotalTime, {
        test_result: String(testExecutionResult),
        package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null,
        type: this.testOptions["testlevel"],
        target_org: this.target_org,
      });

      SFPStatsSender.logElapsedTime("apextest.command.time", elapsedTime, {
        test_result: String(testExecutionResult),
        package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null,
        type: this.testOptions.testLevel,
        target_org: this.target_org,
      });
      SFPStatsSender.logCount("apextests.triggered", {
        test_result: String(testExecutionResult),
        package: this.testOptions instanceof RunAllTestsInPackageOptions ? this.testOptions.sfppackage.package_name : null,
        type: this.testOptions.testLevel,
        target_org: this.target_org,
      });

    }

  }

  private async validateForApexCoverage(): Promise<{
    result: boolean;
    message?: string;
    packageTestCoverage?: number;
    classesCovered?: {
      name: string;
      coveredPercent: number;
    }[];
    classesWithInvalidCoverage?: {
      name: string;
      coveredPercent: number;
    }[];
  }> {
    if (this.testOptions instanceof RunAllTestsInPackageOptions) {

      let packageTestCoverage: PackageTestCoverage = new PackageTestCoverage(
        this.testOptions.sfppackage,
        this.getCoverageReport()
      );

      return packageTestCoverage.validateTestCoverage(
        this.coverageOptions.coverageThreshold
      );
    } else {
      if (this.coverageOptions.isIndividualClassCoverageToBeValidated) {
        let coverageValidator: IndividualClassCoverage = new IndividualClassCoverage(
          this.getCoverageReport()
        );
        return coverageValidator.validateIndividualClassCoverage(
          coverageValidator.getIndividualClassCoverage(),
          this.coverageOptions.coverageThreshold
        );
      } else {
        let coverageValidator: IndividualClassCoverage = new IndividualClassCoverage(
          this.getCoverageReport()
        );
        return coverageValidator.validateIndividualClassCoverage(
          coverageValidator.getIndividualClassCoverage()
        );
      }
    }

  }

  private getTestReport(testId: string) {
    let test_report_json = fs
      .readFileSync(
        path.join(this.testOptions.outputdir, `test-result-${testId}.json`)
      )
      .toString();
    return JSON.parse(test_report_json);
  }

  private getTestId(): string {
    let test_id = fs
      .readFileSync(path.join(this.testOptions.outputdir, "test-run-id.txt"))
      .toString();
    SFPLogger.log("test_id", test_id);
    return test_id;
  }

  private getCoverageReport(): any {
    let testCoverageJSON = fs
      .readFileSync(
        path.join(this.testOptions.outputdir, "test-result-codecoverage.json")
      )
      .toString();

    return JSON.parse(testCoverageJSON);
  }
}
