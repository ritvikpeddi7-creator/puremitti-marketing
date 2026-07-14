This repository currently contains a static HTML site. The `add/video-worker` branch adds a simple backend + worker scaffold to handle user video uploads and asynchronous processing.

What's included
- server.js: Express upload endpoint that stores uploads to S3 and queues a job (BullMQ)
- worker.js: Worker that downloads the source from S3, runs FFmpeg edits, and uploads the result
- package.json: dependencies and scripts
- .env.example: environment variables to configure
- docker-compose.yml: quick local stack with Redis and MinIO (optional)

Default behavior
- Upload a file via POST /upload with form field `video`.
- The server uploads the file to S3 (bucket in S3_BUCKET) under `uploads/` and enqueues a job.
- The worker trims the video (default 0-30s) and writes edited video to `outputs/` in the same bucket.

How to run locally (basic)
1. Install dependencies: `npm install`
2. Run Redis (or use docker-compose): `docker-compose up -d redis`
3. Configure environment variables (see .env.example)
4. Start server: `npm run start`
5. Start worker: `npm run worker`

Notes & next steps
- FFmpeg is CPU intensive. For production, run workers on dedicated machines/containers and autoscale.
- Use direct-to-S3 uploads (pre-signed URLs) for large files to avoid passing big files through the server.
- This scaffold uses AWS S3; you can swap MinIO or other S3-compatible storage.
- The edits payload is JSON-encoded in the `edits` form field (example: `{"trim": {"start": 5, "duration": 30}}`).

If you'd like, I can:
- Add API auth and job status endpoints
- Implement direct S3 signed upload flow
- Add more edit operations (concat, speed, filters) and example client code
- Open a pull request with these changes

Tell me which of those you'd like next and whether to open a PR against the default branch.
