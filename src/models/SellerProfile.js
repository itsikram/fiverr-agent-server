import mongoose from 'mongoose';

const sellerProfileSchema = new mongoose.Schema(
  {
    profileName: String,
    username: String,
    avatarUrl: String,
    avatar_url: String,
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

sellerProfileSchema.index({ username: 1 });

export const SellerProfile = mongoose.model('SellerProfile', sellerProfileSchema);
