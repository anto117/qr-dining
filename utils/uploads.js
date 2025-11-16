// --- utils/uploads.js ---
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Multer to use Cloudinary for storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'ayrasoft-kitchen', // A folder name in your Cloudinary account
    allowed_formats: ['jpg', 'jpeg', 'png'],
  },
});

// Create the multer upload middleware
const upload = multer({ storage: storage });

module.exports = {
  upload,
  cloudinary,
};