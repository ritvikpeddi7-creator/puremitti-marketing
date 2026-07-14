# Production-ready notes and containerization

This branch adds Dockerfiles and a production docker-compose to help run the service and worker in containers.

Dockerfiles
- Dockerfile.server - builds the Express server image
- Dockerfile.worker - builds the worker image

docker-compose.prod.yml
- Runs Redis and MinIO (S3-compatible) for local testing plus server & worker images

Production notes
- Use a real AWS S3 bucket or managed object storage in production. Set S3_ENDPOINT only for S3-compatible local testing.
- Use a managed Redis (ElastiCache, DigitalOcean Managed Redis), or run Redis in a cluster for reliability.
- Run workers on dedicated instances (Kubernetes Deployment or separate autoscaling group). Workers are CPU-intensive and should not be colocated with low-latency web app instances.
- Use IAM roles for S3 access in production rather than static keys.
- Rotate JWT_SECRET and secure it via secrets manager.
- Configure logging and monitoring (stdout to centralized logs, Prometheus metrics for worker CPU/queue length).
- Use pre-signed direct uploads for large files to avoid pushing large payloads through the web server.
- Add rate limiting and authentication for the presign and jobs endpoints.

CI/CD and Deployment
- Build Docker images and push to your registry.
- Deploy server behind a load balancer. Use HTTPS and ensure the presigned URLs are generated with proper bucket policies.
- Use horizontal autoscaling for workers based on queue length.
- Consider using specialized transcoding services (Elastic Transcoder, AWS MediaConvert) for large-scale video workloads.
