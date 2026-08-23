import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'admin'],
    },
    type: String,
    username: String,
    source: String,
    data: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

activitySchema.index({ created_at: -1 });
activitySchema.index({ username: 1 });
activitySchema.index({ role: 1 });

export const Activity = mongoose.model('Activity', activitySchema);
