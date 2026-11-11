import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import userRepository = require('../repositories/userRepository');
type User = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;
type UserRepo = Pick<typeof userRepository, 'create' | 'findById' | 'findByUsername' | 'recordLogin' | 'updateProfile' | 'updatePassword' | 'setStatus'>;
interface UserSession {role?: string; userId?: string; sessionVersion?: number}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;
const STATUS_ACTIVE = 'active';
const STATUS_DISABLED = 'disabled';

function validationError(code: string, message: string) { return Object.assign(new Error(message), {code}); }

function normalizeEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validationError('INVALID_EMAIL', 'A valid email address is required.');
  }
  return email;
}

function normalizeDisplayName(value: unknown, fallback: unknown) {
  const displayName = String(value || fallback || '').trim();
  if (!displayName || displayName.length > 120) throw validationError('INVALID_DISPLAY_NAME', 'Display name is required and must be at most 120 characters.');
  return displayName;
}

function validatePassword(password: unknown) {
  const value = String(password || '');
  if (value.length < 10 || value.length > 256) throw validationError('INVALID_PASSWORD', 'Password must be between 10 and 256 characters.');
  return value;
}

function publicUser(user: User | null) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

class UserService {
  constructor(public repo: UserRepo = userRepository) {}

  async createUser({ username, email = null, displayName, password }: {username: string; email?: string | null; displayName?: string; password: string}) {
    const normalizedUsername = String(username || '').trim();
    if (!USERNAME_RE.test(normalizedUsername)) throw validationError('INVALID_USERNAME', 'Username must be 3-64 characters using letters, numbers, dot, underscore, or hyphen.');
    const id = `usr_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const record = {
      id,
      username: normalizedUsername,
      email: normalizeEmail(email),
      display_name: normalizeDisplayName(displayName, normalizedUsername),
      password_hash: await bcrypt.hash(validatePassword(password), 12),
      role: 'user',
      status: STATUS_ACTIVE,
      principal_id: `principal:user:${id}`,
      profile_id: `profile:user:${id}`,
      session_version: 1,
      created_at: now,
      updated_at: now
    };
    try {
      return publicUser(await this.repo.create(record));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'DB_UNIQUE_CONSTRAINT') throw validationError('USER_ALREADY_EXISTS', 'Username or email is already in use.');
      throw error;
    }
  }

  async authenticate(username: string, password: string) {
    if (!username || !password) return null;
    const user = await this.repo.findByUsername(String(username).trim());
    if (!user || user.role !== 'user' || user.status !== STATUS_ACTIVE) return null;
    if (!await bcrypt.compare(String(password), String(user.password_hash || ''))) return null;
    return publicUser(await this.repo.recordLogin(user.id));
  }

  async currentFromSession(session: UserSession | null | undefined) {
    if (!session || session.role !== 'user' || !session.userId) return null;
    const user = await this.repo.findById(session.userId);
    if (!user || user.role !== 'user' || user.status !== STATUS_ACTIVE) return null;
    if (Number(user.session_version || 1) !== Number(session.sessionVersion || 1)) return null;
    return publicUser(user);
  }

  async updateProfile(userId: string, { displayName, email }: {displayName: string; email?: string | null}) {
    const current = await this.repo.findById(userId);
    if (!current) throw validationError('USER_NOT_FOUND', 'User not found.');
    try {
      return publicUser(await this.repo.updateProfile(userId, {
        displayName: normalizeDisplayName(displayName, current.username),
        email: normalizeEmail(email)
      }));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'DB_UNIQUE_CONSTRAINT') throw validationError('USER_ALREADY_EXISTS', 'Email is already in use.');
      throw error;
    }
  }

  async changePassword(userId: string, newPassword: string) {
    const current = await this.repo.findById(userId);
    if (!current) throw validationError('USER_NOT_FOUND', 'User not found.');
    const hash = await bcrypt.hash(validatePassword(newPassword), 12);
    await this.repo.updatePassword(userId, hash);
    return true;
  }

  async setStatus(userId: string, status: string) {
    if (![STATUS_ACTIVE, STATUS_DISABLED].includes(status)) throw validationError('INVALID_USER_STATUS', 'Invalid user status.');
    const current = await this.repo.findById(userId);
    if (!current) throw validationError('USER_NOT_FOUND', 'User not found.');
    await this.repo.setStatus(userId, status);
    return publicUser(await this.repo.findById(userId));
  }

  async resetPassword(userId: string, newPassword: string) {
    return this.changePassword(userId, newPassword);
  }
}

const instance = Object.assign(new UserService(), {UserService, USERNAME_RE});
export = instance;
