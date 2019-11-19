//Purpose: script allows you to copy from one DynamoDB table to another one
//
//How it works:
// Please make sure that RCU and WCU on DynamoDB tables are configured correctly so the restoration process will not be slowed down.
// First restore DynamoDB table from either PITR or On-Demand backup to a new source table
// Node 10 or higher and AWS SDK should be installed
// Run "myob-auth l"
// In order to run script please type
//  node DynamoDB_CopyTable2TableAsync.js <REGION> <SOURCE TABLE NAME> <DESINATION TABLE NAME> -r
//  where <REGION> is normally ap-southeast-2 (Sydney region)
//        <SOURCE TABLE NAME> is the table where you source data from
//        <DESINATION TABLE NAME> is the table which you restore data to
//        -r is optional flag. If it is specified then all data from <DESINATION TABLE NAME> table will be removed first
//                             If the flag is ommited then data in <DESINATION TABLE NAME> will be UPSERTED

const AWS = require('aws-sdk')

class ProgressBar {
  constructor() {
    this.progressBarTitle;
    this.total;
    this.current;
    this.barLength = process.stdout.columns;

    //Attempt to make progress bar responsive
    process.stdout.on('resize', () => this.update());
  }

  init(total, progressBarTitle = 'Current progress: ') {
    this.progressBarTitle = progressBarTitle;
    this.total = total;
    this.current = 0;
    this.update(this.current);
  }

  update(current) {
    this.barLength = process.stdout.columns - 12 - this.progressBarTitle.length;
    if (current) {
      this.current = current;
    }
    const currentProgress = this.current / this.total;
    this.draw(currentProgress);
  }

  draw(currentProgress) {
    const filledBarLength = (currentProgress * this.barLength).toFixed(0);
    const emptyBarLength = this.barLength - filledBarLength;

    const filledBar = this.getBar(filledBarLength, "\u2588");
    const emptyBar = this.getBar(emptyBarLength, "\u2591");
    const percentageProgress = (currentProgress * 100).toFixed(2);

    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(
      `${this.progressBarTitle}[${filledBar}${emptyBar}] | ${percentageProgress}%`
    );

    if (percentageProgress === 100) {
      process.stdout.write('\n');
    }
  }

  getBar(length, char) {
    let str = "";
    for (let i = 0; i < length; i++) {
      str += char;
    }
    return str;
  }
};

class RestoreDynamoDb {
  async upsertDynamoDbTable(db, runParams, progressBar) {
    let isDone = false;
    const scanParams = {
      TableName: runParams.sourceTable
    };

    try {
      this.logMessage(`---- Start upserting records in ${runParams.destinationTable}`);
      let totalRecNum = 0;
      let i = 0;

      do {
        i++;
        const data = await db.scan(scanParams).promise();

        const batchRecNum = await this.batchWriteDataToTable(db, runParams.destinationTable, data, progressBar, i);

        if (batchRecNum > 0) {
          this.logMessage(`${batchRecNum} records have been processed`);
        }

        isDone = typeof data.LastEvaluatedKey === "undefined";

        // continue scanning if we have more data, because
        // scan can retrieve a maximum of 1MB of data
        if (!isDone) {
          this.logMessage("Scanning for more...");
          scanParams.ExclusiveStartKey = data.LastEvaluatedKey;
        }

        totalRecNum += batchRecNum;
      }
      while (!isDone)

      this.logMessage(`Total ${totalRecNum} records have been processed`);
      this.logMessage(`---- Finished upserting records in ${runParams.destinationTable} SUCCESSFULLY!`);
    } catch (err) {
      this.logMessage('', null, false);
      this.logMessage(`---- Finished upserting in ${runParams.destinationTable} UNSUCCESSFULLY!`, err);
    }
  }

  // Write all the data to the new table
  async batchWriteDataToTable(db, tableName, data, progressBar, scanBatchNum) {
    const batchWriteParams = {
      RequestItems: {
        [tableName]: []
      }
    };

    let batchRecNum = 0;
    const len = data.Items.length;

    if (len > 0) {
      progressBar.init(len, `Progress of scan batch ${scanBatchNum}: `);
    }

    for (const item of data.Items) {
      batchRecNum++;

      batchWriteParams.RequestItems[tableName].push({
        PutRequest: {
          Item: item
        }
      });

      if (batchRecNum % 25 == 0 || batchRecNum == len) {
        await db.batchWrite(batchWriteParams).promise();
        progressBar.update(batchRecNum);

        batchWriteParams.RequestItems[tableName] = [];
      }
    }

    return batchRecNum;
  }

  logMessage(message, err, printTimestamp = true) {
    const dt = new Date();
    let formattedDateTime = '';

    if (printTimestamp) {
      formattedDateTime =
        `${(dt.getMonth()+1).toString().padStart(2, '0')}/${
          dt.getDate().toString().padStart(2, '0')}/${
          dt.getFullYear().toString().padStart(4, '0')} ${
          dt.getHours().toString().padStart(2, '0')}:${
          dt.getMinutes().toString().padStart(2, '0')}:${
          dt.getSeconds().toString().padStart(2, '0')}.${
          dt.getMilliseconds().toString().padStart(3, '0')}: `;
    }

    if (err) {
      console.log(`${formattedDateTime}${message} Error:\n`, err);
    } else {
      console.log(`${formattedDateTime}${message}`);
    }
  }

  getKeyForBatchDeleteItem(tableDescription, dataItem) {
    let result;
    tableDescription.Table.KeySchema.forEach((keyItem) => {
      result = {
        ...result,
        [keyItem.AttributeName]: dataItem[keyItem.AttributeName]
      }
    });

    return result;
  }

  getItemAttrForBatchDeleteRequest(tableDescription, dataItem) {
    return {
      DeleteRequest: {
        Key: this.getKeyForBatchDeleteItem(tableDescription, dataItem)
      }
    };
  }

  async batchDeleteAllRecords(db, tableName, progressBar) {
    let isDone = false;
    let hasError = false;
    let scanParams = {
      TableName: tableName
    };

    try {
      let totalRecNum = 0;

      this.logMessage(`---- Start deleting from ${tableName}`);

      // Create the DynamoDB service object
      const ddb = new AWS.DynamoDB({
        apiVersion: '2012-08-10'
      });

      const tableDescription = await ddb.describeTable({
        TableName: tableName
      }).promise();
      let i = 0;

      do {
        let batchRecNum = 0;
        const batchWriteParams = {
          RequestItems: {
            [tableName]: []
          }
        };

        const data = await db.scan(scanParams).promise();
        const len = data.Items.length;
        i++;

        if (len > 0) {
          progressBar.init(len, `Progress of scan batch ${i}: `);
        }

        for (const item of data.Items) {
          batchRecNum++;

          batchWriteParams.RequestItems[tableName].push({
            ...this.getItemAttrForBatchDeleteRequest(tableDescription, item)
          });

          if (batchRecNum % 25 == 0 || batchRecNum == len) {
            await db.batchWrite(batchWriteParams).promise();

            progressBar.update(batchRecNum);

            batchWriteParams.RequestItems[tableName] = [];
          }
        }

        isDone = typeof data.LastEvaluatedKey === "undefined";

        if (batchRecNum > 0) {
          this.logMessage(`${batchRecNum} records have been deleted`);
        }

        // continue scanning if we have more date, because
        // scan can retrieve a maximum of 1MB of data
        if (!isDone) {
          this.logMessage("Scanning more records...");
          scanParams.ExclusiveStartKey = data.LastEvaluatedKey;
        }
        totalRecNum += batchRecNum;
      }
      while (!isDone)

      //this.logMessage('', null, false);
      this.logMessage(`Total ${totalRecNum} records have been deleted`);
      this.logMessage(`---- Finished deleting from ${tableName} SUCCESSFULLY`);
    } catch (err) {
      hasError = true;
      this.logMessage('', null, false);
      this.logMessage(`---- Finished deleting from ${tableName} UNSUCCESSFULLY!`, err);
    }

    return hasError;
  }

  async restoreTable(params) {
    AWS.config.update({
      region: params.region
    });

    const db = new AWS.DynamoDB.DocumentClient({
      maxRetries: 13,
      retryDelayOptions: {
        base: 200
      }
    });

    const progressBar = new ProgressBar();

    if (params.deleteAllRecords && await this.batchDeleteAllRecords(db, params.destinationTable, progressBar)) {
      return;
    }

    await this.upsertDynamoDbTable(db, params, progressBar);

    this.logMessage('--------- Job is done!');
  }
}

// Run the script
(async () => {
  const args = process.argv.slice(2);

  const runParams = {
    region: args[0],
    sourceTable: args[1],
    destinationTable: args[2],
    deleteAllRecords: args.indexOf('-r') > 0
  };
  
  const restoreDynamoDb = new RestoreDynamoDb();
  await restoreDynamoDb.restoreTable(runParams);
})()
