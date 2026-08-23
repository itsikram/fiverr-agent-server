import mongoose from 'mongoose';

const assignmentSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    clientIds: [String],
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

assignmentSchema.index({ userId: 1 });

export const Assignment = mongoose.model('Assignment', assignmentSchema);
