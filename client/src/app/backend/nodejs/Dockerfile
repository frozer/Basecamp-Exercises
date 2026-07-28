FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application
COPY nodejs_backend.js .

# Expose port
EXPOSE 5000

# Set environment
ENV NODE_ENV=production
ENV FASTAPI_URL=http://fastapi:8000

# Run application
CMD ["node", "nodejs_backend.js"]
