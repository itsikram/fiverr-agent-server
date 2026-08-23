import mongoose from 'mongoose';

const clientSchema = new mongoose.Schema(
  {
    username: String,
    conversationId: String,
    clientKey: String,
    _id: String,
    id: String,
    name: String,
    company: String,
    country: String,
    language: String,
    avatarUrl: String,
    avatar_url: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  {
    _id: false,
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

export const Client = mongoose.model('Client', clientSchema);
