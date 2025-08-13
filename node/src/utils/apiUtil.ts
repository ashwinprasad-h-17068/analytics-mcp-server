import AnalyticsClient from '../AnalyticsClient';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../../.env')
});

interface Config {
  CLIENTID: string | undefined;
  CLIENTSECRET: string | undefined;
  REFRESHTOKEN: string | undefined;
  ORGID: string | undefined;
  MCP_DATA_DIR: string | undefined;
}

export const config: Config = {
  CLIENTID: process.env.ANALYTICS_CLIENT_ID,
  CLIENTSECRET: process.env.ANALYTICS_CLIENT_SECRET,
  REFRESHTOKEN: process.env.ANALYTICS_REFRESH_TOKEN,
  ORGID: process.env.ANALYTICS_ORG_ID,
  MCP_DATA_DIR: process.env.ANALYTICS_MCP_DATA_DIR
};

let analyticsClientInstance: AnalyticsClient | null = null;
export const getAnalyticsClient = (): AnalyticsClient => {
  if (!analyticsClientInstance) {
    if (!config.CLIENTID || !config.CLIENTSECRET || !config.REFRESHTOKEN) {
      throw new Error('Missing required environment variables for AnalyticsClient');
    }
    analyticsClientInstance = new AnalyticsClient(
      config.CLIENTID,
      config.CLIENTSECRET,
      config.REFRESHTOKEN
    );
  }
  return analyticsClientInstance;
};