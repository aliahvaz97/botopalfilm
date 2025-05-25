const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, sparse: true }, // آیدی عددی
  username: { type: String, unique: true, sparse: true } // یوزرنیم (اختیاری)
});

module.exports = mongoose.model('Admin', adminSchema);
