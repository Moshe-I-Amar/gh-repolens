import { Request, Response } from 'express';

export const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
};
