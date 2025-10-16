class S3MultipartUploader {
    constructor() {
        this.partSize = 100 * 1024 * 1024; // 100MB
        this.concurrency = 3;
        this.s3 = null;
        this.uploadId = null;
        this.parts = [];
        this.uploadedBytes = 0;
        this.startTime = null;
        this.file = null;
        this.config = {};

        this.initializeUI();
    }

    initializeUI() {
        const form = document.getElementById('uploadForm');
        const fileInput = document.getElementById('fileInput');
        const fileLabel = document.querySelector('.file-input-label');

        // Handle form submission
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.startUpload();
        });

        // Handle file selection
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                fileLabel.textContent = `📁 ${file.name} (${this.formatFileSize(file.size)})`;
            }
        });

        // Handle drag & drop
        fileLabel.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = '#667eea';
            fileLabel.style.backgroundColor = '#f8f9ff';
        });

        fileLabel.addEventListener('dragleave', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = '#e1e5e9';
            fileLabel.style.backgroundColor = '';
        });

        fileLabel.addEventListener('drop', (e) => {
            e.preventDefault();
            fileLabel.style.borderColor = '#e1e5e9';
            fileLabel.style.backgroundColor = '';
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                fileInput.files = files;
                fileLabel.textContent = `📁 ${files[0].name} (${this.formatFileSize(files[0].size)})`;
            }
        });

        // Overwrite dialog handlers
        document.getElementById('cancelOverwrite').addEventListener('click', () => {
            document.getElementById('overwriteDialog').style.display = 'none';
            this.setUploadStatus(false);
        });

        document.getElementById('confirmOverwrite').addEventListener('click', () => {
            document.getElementById('overwriteDialog').style.display = 'none';
            this.proceedWithUpload();
        });
    }

    async startUpload() {
        try {
            this.clearMessages();
            this.setUploadStatus(true);

            // Get form data
            this.config = {
                accessKey: document.getElementById('accessKey').value,
                secretKey: document.getElementById('secretKey').value,
                region: document.getElementById('region').value,
                bucketName: document.getElementById('bucketName').value,
            };

            this.file = document.getElementById('fileInput').files[0];
            if (!this.file) {
                throw new Error('Please select a file');
            }

            // Set object name
            this.config.objectName = document.getElementById('objectName').value || this.file.name;

            // Configure AWS SDK
            AWS.config.update({
                accessKeyId: this.config.accessKey,
                secretAccessKey: this.config.secretKey,
                region: this.config.region
            });

            this.s3 = new AWS.S3();

            // Check if object exists
            await this.checkObjectExists();

        } catch (error) {
            this.showError(error.message);
            this.setUploadStatus(false);
        }
    }

    async checkObjectExists() {
        this.updateProgress(0, 'Checking if object exists...');

        try {
            // Try to list objects with prefix to check existence
            const result = await this.s3.listObjectsV2({
                Bucket: this.config.bucketName,
                Prefix: this.config.objectName,
                MaxKeys: 1
            }).promise();

            // Check if exact match exists
            const existingObject = result.Contents?.find(obj => obj.Key === this.config.objectName);
            
            if (existingObject) {
                this.showOverwriteDialog();
            } else {
                this.proceedWithUpload();
            }

        } catch (error) {
            // If no ListBucket permission, skip check and proceed
            if (error.code === 'AccessDenied' || error.code === 'Forbidden') {
                this.updateProgress(0, '⚠️ No ListBucket permission - will overwrite if exists');
                setTimeout(() => this.proceedWithUpload(), 1000);
            } else {
                throw error;
            }
        }
    }

    showOverwriteDialog() {
        const dialog = document.getElementById('overwriteDialog');
        const message = document.getElementById('overwriteMessage');
        message.textContent = `Object "${this.config.objectName}" already exists in bucket "${this.config.bucketName}". Do you want to overwrite it?`;
        dialog.style.display = 'block';
    }

    async proceedWithUpload() {
        try {
            this.startTime = Date.now();
            this.uploadedBytes = 0;

            this.updateProgress(0, '🚀 Starting multipart upload...');

            // Create multipart upload
            const createResult = await this.s3.createMultipartUpload({
                Bucket: this.config.bucketName,
                Key: this.config.objectName
            }).promise();

            this.uploadId = createResult.UploadId;

            // Calculate parts
            const totalParts = Math.ceil(this.file.size / this.partSize);
            const partPromises = [];

            // Upload parts with concurrency control
            for (let i = 0; i < totalParts; i++) {
                if (partPromises.length >= this.concurrency) {
                    await Promise.race(partPromises);
                    // Remove completed promises
                    const completedIndex = partPromises.findIndex(p => p.completed);
                    if (completedIndex !== -1) {
                        partPromises.splice(completedIndex, 1);
                    }
                }

                const partPromise = this.uploadPart(i + 1, totalParts);
                partPromises.push(partPromise);
            }

            // Wait for all parts to complete
            await Promise.all(partPromises);

            // Complete multipart upload
            await this.completeMultipartUpload();

        } catch (error) {
            if (this.uploadId) {
                // Abort multipart upload on error
                try {
                    await this.s3.abortMultipartUpload({
                        Bucket: this.config.bucketName,
                        Key: this.config.objectName,
                        UploadId: this.uploadId
                    }).promise();
                } catch (abortError) {
                    console.error('Failed to abort multipart upload:', abortError);
                }
            }
            throw error;
        }
    }

    async uploadPart(partNumber, totalParts) {
        const start = (partNumber - 1) * this.partSize;
        const end = Math.min(start + this.partSize, this.file.size);
        const partData = this.file.slice(start, end);

        const uploadResult = await this.s3.uploadPart({
            Bucket: this.config.bucketName,
            Key: this.config.objectName,
            PartNumber: partNumber,
            UploadId: this.uploadId,
            Body: partData
        }).promise();

        this.parts.push({
            ETag: uploadResult.ETag,
            PartNumber: partNumber
        });

        // Update progress
        this.uploadedBytes += partData.size;
        const progress = (this.uploadedBytes / this.file.size) * 100;
        this.updateProgress(progress, `📊 Uploading part ${partNumber}/${totalParts}...`);

        const promise = Promise.resolve();
        promise.completed = true;
        return promise;
    }

    async completeMultipartUpload() {
        // Sort parts by part number
        this.parts.sort((a, b) => a.PartNumber - b.PartNumber);

        await this.s3.completeMultipartUpload({
            Bucket: this.config.bucketName,
            Key: this.config.objectName,
            UploadId: this.uploadId,
            MultipartUpload: {
                Parts: this.parts
            }
        }).promise();

        const totalTime = Date.now() - this.startTime;
        const avgSpeed = (this.file.size / (totalTime / 1000)) / (1024 * 1024);

        this.updateProgress(100, '✅ Upload completed successfully!');
        this.showSuccess(`
            📁 File: ${this.file.name} (${this.formatFileSize(this.file.size)})<br>
            📍 Destination: s3://${this.config.bucketName}/${this.config.objectName}<br>
            ⏱️ Total time: ${this.formatTime(totalTime / 1000)}<br>
            📈 Average speed: ${avgSpeed.toFixed(1)} MB/s
        `);
        this.setUploadStatus(false);
    }

    updateProgress(percent, message) {
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const speedElement = document.getElementById('uploadSpeed');
        const etaElement = document.getElementById('uploadEta');

        progressContainer.style.display = 'block';
        progressFill.style.width = `${percent}%`;
        progressText.textContent = message;

        if (this.startTime && this.uploadedBytes > 0 && percent > 0 && percent < 100) {
            const elapsed = (Date.now() - this.startTime) / 1000;
            const speed = (this.uploadedBytes / elapsed) / (1024 * 1024);
            speedElement.textContent = `${speed.toFixed(1)} MB/s`;

            // Calculate ETA
            const remainingBytes = this.file.size - this.uploadedBytes;
            const remainingSeconds = remainingBytes / (speed * 1024 * 1024);
            etaElement.textContent = `ETA: ${this.formatTime(remainingSeconds)}`;
        }
    }

    setUploadStatus(uploading) {
        const uploadBtn = document.getElementById('uploadBtn');
        const form = document.getElementById('uploadForm');
        
        uploadBtn.disabled = uploading;
        uploadBtn.textContent = uploading ? 'Uploading...' : 'Start Upload';
        
        // Disable/enable form inputs
        const inputs = form.querySelectorAll('input, select');
        inputs.forEach(input => input.disabled = uploading);
    }

    showError(message) {
        const errorDiv = document.getElementById('errorMsg');
        errorDiv.className = 'error';
        errorDiv.innerHTML = `❌ ${message}`;
    }

    showSuccess(message) {
        const successDiv = document.getElementById('successMsg');
        successDiv.className = 'success';
        successDiv.innerHTML = `✅ ${message}`;
    }

    clearMessages() {
        document.getElementById('errorMsg').innerHTML = '';
        document.getElementById('successMsg').innerHTML = '';
        document.getElementById('progressContainer').style.display = 'none';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatTime(seconds) {
        if (seconds < 60) {
            return `${Math.round(seconds)}s`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const secs = Math.round(seconds % 60);
            return `${minutes}m${secs.toString().padStart(2, '0')}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h${minutes.toString().padStart(2, '0')}m`;
        }
    }
}

// Initialize the uploader when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new S3MultipartUploader();
});