//Purpose: script allows you to copy from one DynamoDB table to another one
//
//How it works:
// Please make sure that RCU and WCU on DynamoDB tables are configured correctly so the restoration process will not be slowed down.
// First restore DynamoDB table from either PITR or On-Demand backup to a new source table
// Node and AWS SDJ should be installed
// In order to run script please type
//  node DynamoDB_CopyTable2TableAsync.js <REGION> <SOURCE TABLE NAME> <DESINATION TABLE NAME> -r
//  where <REGION> is normally ap-southeast-2 (Sydney region)
//        <SOURCE TABLE NAME> is the table where you source data from
//        <DESINATION TABLE NAME> is the table which you restore data to
//        -r is optional flag. If it is specified then all data from <DESINATION TABLE NAME> table will be removed first
//                             If the flag is ommited then data in <DESINATION TABLE NAME> will be UPSERTED

const AWS = require('aws-sdk')

const upsertDynamoDbTable = async (db, runParams) => {
    let isDone = false;
    const scanParams = {
        TableName: runParams.sourceTable
    };

    logMessage(`---- Start updating records in ${runParams.destinationTable}`);

    do {
        const data = await db.scan(scanParams).promise();

        await batchWriteDataToTable(db, runParams.destinationTable, data);

        isDone = typeof data.LastEvaluatedKey === "undefined";

        // continue scanning if we have more data, because
        // scan can retrieve a maximum of 1MB of data
        if (!isDone) {
            logMessage("Scanning for more...");
            scanParams.ExclusiveStartKey = data.LastEvaluatedKey;
        }
    }
    while (!isDone)

    logMessage(`---- Finished updating records in ${runParams.destinationTable}`);
}

// Write all the data to the new table
const batchWriteDataToTable = async (db, tableName, data) => {
    const batchWriteParams = {
        RequestItems: {
            [tableName]: []
        }
    };

    let batchRecNum = 0;
    let successfulUpserts = 0;

    for (const item of data.Items) {
        batchRecNum++;
        successfulUpserts++;

        batchWriteParams.RequestItems[tableName].push({
            PutRequest: {
                Item: item
            }
        });

        if (batchRecNum % 25 == 0 || successfulUpserts == data.Items.length) {
            await db.batchWrite(batchWriteParams,
                err => {
                    if (err) {
                        logMessage(`Unable to upsert records in ${tableName}. Error JSON: ${JSON.stringify(err, null, 2)}`);
                    }
                }).promise();

            logMessage(`${successfulUpserts} out of ${data.Items.length} records have been processed`);

            batchRecNum = 0;

            batchWriteParams.RequestItems[tableName] = [];
        }
    }
}

const logMessage = (message) => {
    const dt = new Date();
    const formattedDateTime =
        `${(dt.getMonth()+1).toString().padStart(2, '0')}/${
        dt.getDate().toString().padStart(2, '0')}/${
        dt.getFullYear().toString().padStart(4, '0')} ${
        dt.getHours().toString().padStart(2, '0')}:${
        dt.getMinutes().toString().padStart(2, '0')}:${
        dt.getSeconds().toString().padStart(2, '0')}.${
        dt.getMilliseconds().toString().padStart(3, '0')}`;
    console.log(`${formattedDateTime}: ${message}`);
}

const getKeyForBatchDeleteItem = (tableDescription, dataItem, keepAttributeType = false) => {
    let result;
    tableDescription.Table.KeySchema.forEach((keyItem) => {
        result = {
            ...result,
            [keyItem.AttributeName]:
                !keepAttributeType && dataItem[keyItem.AttributeName] !== null &&
                typeof dataItem[keyItem.AttributeName] === 'object' ?
                dataItem[keyItem.AttributeName][Object.keys(dataItem[keyItem.AttributeName])[0]] : dataItem[keyItem.AttributeName]
        }
    });

    return result;
}

getItemAttrForBatchDeleteRequest = (tableDescription, dataItem) => {
    return {
        DeleteRequest: {
            Key: getKeyForBatchDeleteItem(tableDescription, dataItem)
        }
    };
}

const batchDeleteAllRecords = async (db, tableName) => {
    let isDone = false;
    let scanParams = {
        TableName: tableName
    };
    let hasError = false;

    logMessage(`---- Start deleting from ${tableName}`);

    // Create the DynamoDB service object
    var ddb = new AWS.DynamoDB({
        apiVersion: '2012-08-10'
    });

    const tableDescription = await ddb.describeTable({
        TableName: tableName
    }).promise();

    do {
        let successfulDeletes = 0;

        const data = await db.scan(scanParams).promise();

        try {
            const batchWriteParams = {
                RequestItems: {
                    [tableName]: []
                }
            };

            let batchRecNum = 0;

            for (const item of data.Items) {
                batchRecNum++;
                successfulDeletes++;

                batchWriteParams.RequestItems[tableName].push({
                    ...getItemAttrForBatchDeleteRequest(tableDescription, item)
                });

                if (batchRecNum % 25 == 0 || successfulDeletes == data.Items.length) {
                    await db.batchWrite(batchWriteParams,
                        err => {
                            if (err) {
                                logMessage(`Unable to delete records from ${tableName}. Error JSON: ${JSON.stringify(err, null, 2)}`);
                            }
                        }).promise();

                    logMessage(`${successfulDeletes} out of ${data.Items.length} records have been deleted`);

                    batchRecNum = 0;

                    batchWriteParams.RequestItems[tableName] = [];
                }
            }
        } catch (e) {
            // If something fails, log it
            logMessage('error', e);
            hasError = true;
            break;
        }

        isDone = typeof data.LastEvaluatedKey === "undefined";

        // continue scanning if we have more date, because
        // scan can retrieve a maximum of 1MB of data
        if (!isDone) {
            logMessage("Scanning more records...");
            scanParams.ExclusiveStartKey = data.LastEvaluatedKey;
        }
    }
    while (!isDone)

    logMessage(`---- Finished deleting from ${tableName}`);

    return hasError;
}

const runTask = async (region, runParams) => {

}

// Run the script
(async () => {
    const args = process.argv.slice(2);

    const runParams = {
        sourceTable: args[1],
        destinationTable: args[2],
        deleteAllRecords: false
    };

    runParams.deleteAllRecords = args.indexOf('-r') > 0;

    AWS.config.update({
        region: args[0]
    });

    const db = new AWS.DynamoDB.DocumentClient({
        maxRetries: 13,
        retryDelayOptions: {
            base: 200
        }
    });

    if (runParams.deleteAllRecords) {
        const hasError = await batchDeleteAllRecords(db, runParams.destinationTable);
        if (hasError) {
            return;
        }
    }

    await upsertDynamoDbTable(db, runParams);

    logMessage('--------- Job is done!');

    await runTask(args[0], runParams);
})()
