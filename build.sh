#!/bin/bash
# This script installs dependencies and prepares the application for deployment

# Install server dependencies
npm install

# Create uploads directory if it doesn't exist
mkdir -p uploads

# Output message
echo "Build completed successfully!"