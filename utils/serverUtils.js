/**
 * Utility functions for MessageServer
 */

/**
 * Generate a unique session ID
 * @param {Object} context - Context object (for compatibility with Python version)
 * @returns {string} Session ID
 */
export function generateSessionId(context = null) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `session_${timestamp}_${random}`;
}

/**
 * Check if a port is available
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available
 */
export async function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    
    server.listen(port, () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * Find process using a port (Windows)
 * @param {number} port - Port number
 * @returns {Promise<number|null>} Process ID or null
 */
export async function findProcessUsingPort(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    
    const { exec } = require('child_process');
    exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parseInt(parts[parts.length - 1]);
          if (!isNaN(pid)) {
            resolve(pid);
            return;
          }
        }
      }
      resolve(null);
    });
  });
}

/**
 * Get command to kill a port (Windows)
 * @param {number} port - Port number
 * @returns {string|null} Kill command or null
 */
export function getKillPortCommand(port) {
  if (process.platform !== 'win32') {
    return null;
  }
  return `netstat -ano | findstr :${port} | findstr LISTENING | for /f "tokens=5" %a in ('more') do taskkill /F /PID %a`;
}
