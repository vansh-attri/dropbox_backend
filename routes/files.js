const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth');
const File = require('../models/File');
const Folder = require('../models/Folder');
const User = require('../models/User');
const router = express.Router();

// Configure multer for file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user._id.toString();
    const userDir = path.join(__dirname, '../uploads', userId);
    
    // Create user directory if it doesn't exist
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    // Create unique filename with original name
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

// Filter files by size and type
const fileFilter = (req, file, cb) => {
  // Check if user has enough storage
  const user = req.user;
  const fileSize = parseInt(req.headers['content-length']);
  
  if (user.storageUsed + fileSize > user.storageLimit) {
    return cb(new Error('Storage limit exceeded'), false);
  }
  
  // Allow all file types
  cb(null, true);
};

const upload = multer({ 
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB limit
});

// Get files and folders
router.get('/', auth, async (req, res) => {
  try {
    const { folderId } = req.query;
    const userId = req.user._id;
    
    // Query for files and folders
    const fileQuery = { 
      owner: userId,
      folder: folderId || null
    };
    
    const folderQuery = {
      owner: userId,
      parent: folderId || null
    };
    
    // Get both files and folders
    const [files, folders] = await Promise.all([
      File.find(fileQuery).sort({ createdAt: -1 }),
      Folder.find(folderQuery).sort({ createdAt: -1 })
    ]);
    
    res.json({ files, folders });
  } catch (err) {
    console.error('Error fetching files:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Upload file
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    const { folderId } = req.body;
    const fileSize = req.file.size;
    const userId = req.user._id;
    
    // Create new file record
    const file = new File({
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: fileSize,
      path: req.file.path,
      owner: userId,
      folder: folderId || null
    });
    
    // Save file record
    await file.save();
    
    // Update user's storage used
    await User.findByIdAndUpdate(userId, {
      $inc: { storageUsed: fileSize }
    });
    
    res.status(201).json({
      message: 'File uploaded successfully',
      file
    });
  } catch (err) {
    console.error('File upload error:', err);
    
    // If there was an error, delete the uploaded file if it exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// Download file
router.get('/download/:fileId', auth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user._id;
    
    // Find file
    const file = await File.findOne({
      _id: fileId,
      $or: [
        { owner: userId },
        { sharedWith: { $elemMatch: { user: userId } } },
        { isPublic: true }
      ]
    });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found or access denied' });
    }
    
    // Send file
    res.download(file.path, file.originalName);
  } catch (err) {
    console.error('File download error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create folder
router.post('/folder', auth, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    const userId = req.user._id;
    
    // Validate name
    if (!name) {
      return res.status(400).json({ message: 'Folder name is required' });
    }
    
    // Create folder
    const folder = new Folder({
      name,
      owner: userId,
      parent: parentId || null
    });
    
    // Save folder
    await folder.save();
    
    res.status(201).json({
      message: 'Folder created successfully',
      folder
    });
  } catch (err) {
    console.error('Folder creation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete file
router.delete('/file/:fileId', auth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user._id;
    
    // Find file
    const file = await File.findOne({ _id: fileId, owner: userId });
    if (!file) {
      return res.status(404).json({ message: 'File not found or access denied' });
    }
    
    // Delete file from filesystem
    if (file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    
    // Update user's storage used
    await User.findByIdAndUpdate(userId, {
      $inc: { storageUsed: -file.size }
    });
    
    // Delete file record
    await file.deleteOne();
    
    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    console.error('File deletion error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete folder
router.delete('/folder/:folderId', auth, async (req, res) => {
  try {
    const { folderId } = req.params;
    const userId = req.user._id;
    
    // Find folder
    const folder = await Folder.findOne({ _id: folderId, owner: userId });
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found or access denied' });
    }
    
    // Get all files in this folder
    const files = await File.find({ folder: folderId });
    
    // Delete all files
    for (const file of files) {
      // Delete file from filesystem
      if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }
    
    // Calculate total size of deleted files
    const totalSize = files.reduce((total, file) => total + file.size, 0);
    
    // Update user's storage used
    if (totalSize > 0) {
      await User.findByIdAndUpdate(userId, {
        $inc: { storageUsed: -totalSize }
      });
    }
    
    // Delete all files in folder from database
    await File.deleteMany({ folder: folderId });
    
    // Delete folder record
    await folder.deleteOne();
    
    res.json({ message: 'Folder and all its contents deleted successfully' });
  } catch (err) {
    console.error('Folder deletion error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Share file with another user
router.post('/share/file/:fileId', auth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { email, permission } = req.body;
    const userId = req.user._id;
    
    // Validate input
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    
    // Find target user
    const targetUser = await User.findOne({ email });
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Can't share with yourself
    if (targetUser._id.toString() === userId.toString()) {
      return res.status(400).json({ message: 'Cannot share with yourself' });
    }
    
    // Find file
    const file = await File.findOne({ _id: fileId, owner: userId });
    if (!file) {
      return res.status(404).json({ message: 'File not found or access denied' });
    }
    
    // Check if already shared with user
    const isAlreadyShared = file.sharedWith.some(
      share => share.user.toString() === targetUser._id.toString()
    );
    
    if (isAlreadyShared) {
      // Update sharing permission
      await File.updateOne(
        { 
          _id: fileId, 
          'sharedWith.user': targetUser._id 
        },
        {
          $set: { 'sharedWith.$.permission': permission || 'read' }
        }
      );
    } else {
      // Add new share
      file.sharedWith.push({
        user: targetUser._id,
        permission: permission || 'read'
      });
      
      await file.save();
    }
    
    res.json({ 
      message: `File shared with ${targetUser.email} successfully`,
      sharedWith: {
        user: {
          _id: targetUser._id,
          email: targetUser.email,
          name: targetUser.name
        },
        permission: permission || 'read'
      }
    });
  } catch (err) {
    console.error('File sharing error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Make file public/private
router.patch('/file/:fileId/public', auth, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { isPublic } = req.body;
    const userId = req.user._id;
    
    // Validate input
    if (isPublic === undefined) {
      return res.status(400).json({ message: 'isPublic field is required' });
    }
    
    // Find and update file
    const file = await File.findOneAndUpdate(
      { _id: fileId, owner: userId },
      { isPublic },
      { new: true }
    );
    
    if (!file) {
      return res.status(404).json({ message: 'File not found or access denied' });
    }
    
    res.json({
      message: `File is now ${isPublic ? 'public' : 'private'}`,
      file
    });
  } catch (err) {
    console.error('File visibility update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;