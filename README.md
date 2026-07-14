Updated README with features and next steps.

Key additions:
- Job status endpoints: GET /jobs/:id
- Presigned upload flow: POST /presign (returns put URL and key) + POST /jobs to enqueue after upload
- Simple JWT auth and RBAC with /auth/token demo endpoint
- More edit capabilities: concat, speed, filters, auto_highlight (naive)
- Dockerfiles & production docker-compose
- PRODUCTION.md with deployment notes
