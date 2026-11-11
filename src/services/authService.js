const adminIdentity = require('./adminIdentityService');
const databaseManager = require('../db/databaseManager');
const userService = require('./userService');

class AuthService {
  async authenticate(username, password) {
    if (!username || !password) return { success: false, message: 'Username and password are required' };
    const admin = adminIdentity.authenticate(username, password);
    if (admin) return { success: true, user: admin };
    if (databaseManager.isOperational()) {
      const user = await userService.authenticate(username, password);
      if (user) return { success: true, user: { ...user, auth_source: 'database' } };
    }
    return { success: false, message: 'Invalid username or password' };
  }

  async currentIdentity(session) {
    const admin = adminIdentity.currentFromSession(session);
    if (admin) return admin;
    if (!databaseManager.isOperational()) return null;
    return userService.currentFromSession(session);
  }
}

module.exports = new AuthService();
