const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Instance method — compares a plaintext password against the stored hash.
// Never store or compare plaintext passwords directly.
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Static helper — hashes a plaintext password for storage. Called from
// the registration route, kept here so hashing logic lives with the model.
userSchema.statics.hashPassword = async function (plainPassword) {
  const SALT_ROUNDS = 12;
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
};

// Never serialize the password hash back to a client, even by accident
// (e.g. res.json(user)). This runs automatically whenever a User doc is
// converted to JSON.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
