export const config = { runtime: 'edge' }

export default function handler(_req: Request): Response {
  return Response.json({ version: '0.1.0' })
}

