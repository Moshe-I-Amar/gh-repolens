import path from 'path';
import { promises as fs } from 'fs';

import { createLogger } from '@repolens/shared-utils';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export const createVibeManifest = async (workspace: string, payload: Record<string, unknown>) => {
  const manifestPath = path.join(workspace, 'vibe.project.json');
  try {
    await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2));
  } catch (error) {
    logger.error({ error, manifestPath }, 'Failed to write vibe manifest');
    throw error;
  }
};
