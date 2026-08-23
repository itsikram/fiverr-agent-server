import mongoose from 'mongoose';

const webPushSubscriptionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['web-push'],
      default: 'web-push',
    },
    endpoint: {
      type: String,
      unique: true,
      required: true,
    },
    subscription: mongoose.Schema.Types.Mixed,
    userId: String,
    sessionId: String,
    registeredAt: Date,
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

export const WebPushSubscription = mongoose.model('WebPushSubscription', webPushSubscriptionSchema);
