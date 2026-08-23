import mongoose from 'mongoose';

/**
 * Connect to MongoDB using Mongoose
 */


export async function connectDatabase  () {
  const mongoUrl = process.env.MONGODB_URI ;
  // console.log('[Database] Connecting to MongoDB...', mongoUrl);

  try {
    await mongoose.connect(mongoUrl, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      maxPoolSize: 10,
    });

    console.log('[Database] ✓ Connected to MongoDB successfully');
    return true;
  } catch (error) {
    console.warn('[Database] ⚠️  MongoDB connection failed:', error.message);
    console.warn('[Database] ⚠️  Server will start without database connection');
    console.warn('[Database] ⚠️  To fix: Set MONGODB_URI in your .env file');
    console.warn('[Database] ⚠️  Connection string:', (mongoUrl || '').replace(/:[^:]+@/, ':****@'));
    return false;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    console.log('[Database] Disconnected from MongoDB');
  } catch (error) {
    console.error('[Database] Disconnect error:', error.message);
  }
}

/**
 * Check database connection status
 */
export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}
