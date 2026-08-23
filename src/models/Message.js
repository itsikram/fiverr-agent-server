import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    _id: String,
    id: String,
    clientId: String,
    clientUsername: String,
    conversationId: String,
    sender: {
      type: String,
    },
    text: String,
    timestamp: Date,
    isFromMe: Boolean,
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

messageSchema.index({ conversationId: 1 });
messageSchema.index({ clientUsername: 1 });
messageSchema.index({ timestamp: -1 });

export const Message = mongoose.model('Message', messageSchema);
