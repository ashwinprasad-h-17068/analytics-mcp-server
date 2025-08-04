import { z } from "zod";
import type { ServerInstance } from "../common";
import {getAnalyticsClient, config } from '../utils/apiUtil';
import { parseCSVData, inferDataType } from "../utils/data-util"

export function registerDataTools(server: ServerInstance) {

    server.registerTool("query_data",
    {
        description: `
        <use_case>
        1. Executes a SQL query on the specified workspace and returns the top 20 rows as results.
        2. This can be used to retrieve data from Zoho Analytics using custom SQL queries.
        3. Use this when user asks for any queries from the data in the workspace.
        4. Use this to gather insights from the data in the workspace and answer user queries.
        5. Can be used to answer natural language queries by analysing the result of the SQL query.
        </use_case>

        <important_notes>
        - Always try to provide a mysql compatible sql select query alone.
        - Try to optimize the query to return only the required data and minimize the amount of data returned.
        - If table or column names contain spaces or special characters, enclose them in double quotes (e.g., "Column Name").
        - Do not use more than one level of nested sub-queries.
        - Instead of doing n queries, try to combine them into a single query using joins or unions or sub-queries, while ensuring the query remains efficient.
        </important_notes>

        <returns>
            Result of the SQL query in a comma-separated (list of list) format of the top 20 rows alone, the first row contains the column names. 
            If an error occurs, returns an error message.
        </returns>
        `,
        inputSchema: {
        workspaceId: z.string().describe("The ID of the workspace where the query will be executed"),
        sql_query: z.string().describe("The SQL query to be executed")
        }
    },
    async ({ workspaceId, sql_query }) => {
        try {
            const analyticsClient = getAnalyticsClient();
            const bulk = analyticsClient.getBulkInstance(config.ORGID, workspaceId);
            const job_id = await bulk.initiateBulkExportUsingSQL(sql_query, "CSV");
            let waitTime = 2000;
            const startTime = Date.now();
            const MAX_WAIT_TIME = 60 * 1000;
            let status = "IN_PROGRESS";
            while (status === "IN_PROGRESS") {
                if (Date.now() - startTime > MAX_WAIT_TIME) {
                    throw new Error("The query is taking too long to execute. Please try again later.");
                }
                await new Promise(resolve => setTimeout(resolve, waitTime));
                const jobDetails = await bulk.getExportJobDetails(job_id);
                status = (jobDetails as any).status;
                if (status === "COMPLETED") {
                    break;
                }
                waitTime = Math.min(waitTime * 2, 16000);
            }
            if (status !== "COMPLETED") {
                throw new Error(`Bulk export job failed or timed out. Status: ${status}`);
            }
            const tmpFilePath = `/tmp/${job_id}.csv`;
            await bulk.exportBulkData(job_id, tmpFilePath);
            const fs = require('fs');
            const csvData = fs.readFileSync(tmpFilePath, 'utf8');
            const parsedData = parseCSVData(csvData);
            const ROW_LIMIT = 20;
            const limitedRows = parsedData.rows.slice(0, ROW_LIMIT);
            fs.unlinkSync(tmpFilePath);
            return {
                content: [
                    { 
                        type: "text", 
                        text: `Query executed successfully. Retrieved ${limitedRows.length} rows.` 
                    },
                    {
                        type: "text",
                        text: JSON.stringify({
                            columns: parsedData.columns,
                            rows: limitedRows
                        })
                    }
                ]
            };
        } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ 
                type: "text", 
                text: `An error occurred while executing the query: ${errorMessage}` 
            }]
        };
        }
    });

    server.registerTool("analyze_file_structure",
    {
        description: `
        <use_case>
        1. Analyzes the structure of a file (CSV or JSON) to determine its columns and data types.
        2. This can be used to understand the structure of a file before importing it into Zoho Analytics.
        3. If the table does not already exist and a file needs to be imported, this tool can be used to analyze the file structure and create a new table with the appropriate columns. 
        </use_case>

        <important_notes>
        - This tool supports only local files. If the file is a remote URL, download it first using the download_file tool.
        - The returned data types will not be the exact data types used in Zoho Analytics, but rather a general representation of the data types in Python.
        </important_notes>

        <returns>
            A dictionary containing the column names and their respective data types.
        </returns>
        `,
        inputSchema: {
        file_path: z.string().describe("The path to the local file to be analyzed")
        }
    },
    async ({ file_path }) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const csv = require('csv-parser');
            if (!fs.existsSync(file_path)) {
                return {
                    content: [{ 
                        type: "text", 
                        text: `${file_path} does not exist. Please provide a valid file path.` 
                    }]
                };
            }
            const fileExtension = path.extname(file_path).toLowerCase();            // Process based on file type
            if (fileExtension === '.csv') {
                return await new Promise<any>((resolve, reject) => {
                    const results: Record<string, string>[] = [];
                    const structure: Record<string, string> = {};
                    
                    fs.createReadStream(file_path)
                        .pipe(csv())
                        .on('headers', (headers: string[]) => {
                            // Initialize structure with headers
                            headers.forEach(header => {
                                structure[header] = ''; // Will be determined later
                            });
                        })
                        .on('data', (data: Record<string, string>) => {
                            results.push(data);
                            
                            // If we don't have types yet and we have some data, try to infer types
                            if (Object.values(structure).some(v => v === '') && results.length === 1) {
                                Object.entries(data).forEach(([column, value]) => {
                                    if (value === null || value === '') {
                                        structure[column] = 'TEXT'; // Default for empty values
                                    } else if (!isNaN(parseInt(value)) && parseInt(value).toString() === value) {
                                        structure[column] = 'NUMBER';
                                    } else if (!isNaN(parseFloat(value))) {
                                        structure[column] = 'DECIMAL';
                                    } else if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
                                        structure[column] = 'BOOLEAN';
                                    } else {
                                        structure[column] = 'TEXT';
                                    }
                                });
                            }
                        })
                        .on('end', () => {
                            // Set any remaining untyped columns to TEXT
                            Object.keys(structure).forEach(key => {
                                if (structure[key] === '') {
                                    structure[key] = 'TEXT';
                                }
                            });
                            
                            resolve({
                                content: [
                                    { 
                                        type: "text", 
                                        text: `Successfully analyzed CSV file structure at: ${file_path}` 
                                    },
                                    {
                                        type: "json",
                                        json: structure
                                    }
                                ]
                            });
                        })
                        .on('error', (error: Error) => {
                            reject({
                                content: [{ 
                                    type: "text", 
                                    text: `Error parsing CSV file: ${error.message}` 
                                }]
                            });
                        });
                });
                
            } else if (fileExtension === '.json') {
                const fileData = JSON.parse(fs.readFileSync(file_path, 'utf8'));
                
                if (Array.isArray(fileData) && fileData.length > 0 && typeof fileData[0] === 'object') {
                    const firstObject = fileData[0];
                    const structure: Record<string, string> = {};
                    
                    // Analyze the first object to determine types
                    for (const [column, value] of Object.entries(firstObject)) {
                        if (typeof value === 'number') {
                            // Check if it's an integer
                            if (Number.isInteger(value)) {
                                structure[column] = 'NUMBER';
                            } else {
                                structure[column] = 'DECIMAL';
                            }
                        } else if (typeof value === 'boolean') {
                            structure[column] = 'BOOLEAN';
                        } else {
                            structure[column] = 'TEXT';
                        }
                    }
                    
                    return {
                        content: [
                            { 
                                type: "text", 
                                text: `Successfully analyzed JSON file structure at: ${file_path}` 
                            },
                            {
                                type: "json",
                                json: structure
                            }
                        ]
                    };
                } else {
                    return {
                        content: [{ 
                            type: "text", 
                            text: "Invalid JSON format. Expected a list of objects." 
                        }]
                    };
                }
                
            } else {
                return {
                    content: [{ 
                        type: "text", 
                        text: "Unsupported file type. Please provide a CSV or JSON file." 
                    }]
                };
            }
        }
        catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `An error occurred while analyzing file structure: ${errorMessage}` 
                }]
            };
        }
    });

    server.registerTool("export_view",
    {
        description: `
        <use_case>
            Export an object from the workspace in the specified format. These objects can be tables, charts, or dashboards.
        </use_case>

        <important_notes>
            Mostly prefer html for charts and dashboards, and csv for tables.
        </important_notes>
        `,
        inputSchema: {
            workspaceId: z.string().describe("The ID of the workspace from which to export objects"),
            view_id: z.string().describe("The ID of the Zoho Analytics view to be exported. This can be a table, chart, or dashboard"),
            response_file_format: z.enum(["csv", "html", "pdf"]).describe("The format in which to export the objects. Supported formats are \"csv\", \"html\", \"pdf\""),
            response_file_path: z.string().describe("The path where the exported file will be saved")
        }
    },
    async ({ workspaceId, view_id, response_file_format, response_file_path }) => {
        try {

            const analyticsClient = getAnalyticsClient();
            const bulk = analyticsClient.getBulkInstance(config.ORGID || "", workspaceId);
            const path = require('path');
            const fs = require('fs');
            let fullPath = response_file_path;
            if (config.MCP_DATA_DIR) {
                fullPath = path.join(config.MCP_DATA_DIR, response_file_path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }
            await bulk.exportData(view_id, response_file_format, fullPath);
            return {
                content: [{ 
                    type: "text", 
                    text: `Object exported successfully to ${fullPath} in ${response_file_format} format.` 
                }]
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `An error occurred while exporting the view: ${errorMessage}` 
                }]
            };
        }
    });

    server.registerTool("download_file",
    {
        description: `
        <use_case>
        1. Downloads a file from a given URL and saves it to a local directory.
        2. This can be used to download files that need to be imported into Zoho Analytics.
        </use_case>

        <returns>
            A string indicating the path where the file has been saved locally.
        </returns>
        `,
        inputSchema: {
        file_url: z.string().describe("The URL of the file to be downloaded")
        }
    },
    async ({ file_url }) => {
        try {   
            const fs = require('fs');
            const path = require('path');
            const axios = require('axios');
            const url = require('url');
            const downloadDir = config.MCP_DATA_DIR || '/tmp';
            fs.mkdirSync(downloadDir, { recursive: true });
            const parsedUrl = new URL(file_url);
            let filename = path.basename(parsedUrl.pathname);
            const fileType = file_url.split('.').pop()?.toLowerCase() || '';
            if (!filename) {
                filename = `downloaded_file.${fileType}`;
            }
            const downloadedPath = path.join(downloadDir, filename);
            const response = await axios({
                method: 'GET',
                url: file_url,
                responseType: 'stream',
            });
            const writer = fs.createWriteStream(downloadedPath);
            response.data.pipe(writer);
            return await new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    resolve({
                        content: [{ 
                            type: "text", 
                            text: `File downloaded successfully and saved to ${downloadedPath}` 
                        }]
                    });
                });
                writer.on('error', (err: Error) => {
                    reject({
                        content: [{ 
                            type: "text", 
                            text: `An error occurred while downloading the file: ${err.message}` 
                        }]
                    });
                });
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `Failed to download the file. Please check the URL and try again. Please make sure the file is accessible and the URL is correct. Error: ${errorMessage}` 
                }]
            };
        }
    });

    server.registerTool("import_data",
    {
        description: `
        <use_case>
        1. Imports data into a specified table in a workspace. The data to be imported should be provided as a list of dictionaries or as a file path (only local file). If file_path is provided, the format of the file should also be provided (csv or json), else the data parameter will be used.
        2. This can be used for both file upload as well as direct data import into a table.
        </use_case>

        <important_notes>
        - Make sure the the table already exists in the workspace before importing data.
        - If no table exists, create a table first using the create_table tool before importing the data.
        - if the file_path is a remote URL, download the file using download_file tool before using this tool.
        - if the file_path is a remote URL and table does not exist, you can create a new table using the create_table tool, analyse the structure (column structure of the table) of the file using analyse_file_structure tool and then import the data.
        </important_notes>

        <returns>
            A string indicating the result of the import operation. If successful, it returns a success message; otherwise, it returns an error message.
        </returns>
        `,
        inputSchema: {
        workspaceId: z.string().describe("The ID of the workspace containing the table"),
        tableId: z.string().describe("The ID of the table to which data will be added. It is None if the data needs to be added to a new table"),
        data: z.array(z.record(z.string(), z.any())).optional().describe("The data to be added to the table in json format"),
        file_path: z.string().optional().describe("The path to a local file containing data to be added to the table"),
        file_type: z.enum(["csv", "json"]).optional().describe("The type of the file being imported (\"csv\", \"json\")")
        }
    },
    async ({ workspaceId, tableId, data, file_path, file_type }) => {
        try {

            const analyticsClient = getAnalyticsClient();
            const bulk = analyticsClient.getBulkInstance(config.ORGID || "", workspaceId);
            if (file_path) {
                if (file_path.startsWith("https")) {
                    return {
                        content: [{ 
                            type: "text", 
                            text: "File path cannot be a remote URL. Please download the file using the download_file tool and provide the local file path." 
                        }]
                    };
                }
                const fs = require('fs');
                if (!fs.existsSync(file_path)) {
                    return {
                        content: [{ 
                            type: "text", 
                            text: `File ${file_path} does not exist. Please provide a valid local file path.` 
                        }]
                    };
                }
                if (!file_type || (file_type !== "csv" && file_type !== "json")) {
                    return {
                        content: [{ 
                            type: "text", 
                            text: "Invalid file type. Please provide 'csv' or 'json'." 
                        }]
                    };
                }
                const result = await bulk.importData(tableId, "append", file_type, "true", file_path, { delimiter: '0' });
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify(result) 
                    }]
                };
            }
            if (!data) {
                return {
                    content: [{ 
                        type: "text", 
                        text: "No data provided to import. Please provide either 'data' or 'local_file_path'." 
                    }]
                };
            }
            const result = await bulk.importRawData(tableId, "append", "json", "true", JSON.stringify(data), { delimiter: '0' });
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify(result)  
                }]
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ 
                    type: "text", 
                    text: `An error occurred while adding data to the table: ${errorMessage}` 
                }]
            };
        }
    });
}