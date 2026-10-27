import { handle } from '../../src/server/app.mjs';

export default async (req, context) => handle(req, { ip: context?.ip || req.headers.get('x-nf-client-connection-ip') || '0.0.0.0' });

export const config = { path: '/api/*' };
