import * as adminIdentity from './adminIdentityService';
import databaseManager from '../db/databaseManager';
import userService from './userService';

class AuthService {
  async authenticate(username: string, password: string) {
    if (!username || !password)
      return { success: false, message: 'Username and password are required' };
    const admin = await adminIdentity.authenticate(username, password);
    if (admin) return { success: true, user: admin };
    if (databaseManager.isOperational()) {
      const user = await userService.authenticate(username, password);
      if (user) return { success: true, user: { ...user, auth_source: 'database' } };
    }
    return { success: false, message: 'Invalid username or password' };
  }

  async currentIdentity(
    session: Parameters<typeof userService.currentFromSession>[0] &
      Parameters<typeof adminIdentity.currentFromSession>[0],
  ) {
    const admin = adminIdentity.currentFromSession(session);
    if (admin) return admin;
    if (!databaseManager.isOperational()) return null;
    return userService.currentFromSession(session);
  }
}

export = new AuthService();
