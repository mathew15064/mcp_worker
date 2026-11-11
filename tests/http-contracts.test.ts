import test from 'node:test';
import assert from 'node:assert/strict';
import { formString, formList, formFlag, InvalidFormField } from '../src/http/requestContracts';
import { routeError } from '../src/http/domainErrors';

void test('form contract permits legacy HTML scalar, repeated scopes and empty checkbox', () => {
  assert.equal(formString({ name: 'profile' }, 'name'), 'profile');
  assert.equal(formString({}, 'name'), '');
  assert.equal(formFlag({ enabled: 'true' }, 'enabled'), true);
  assert.equal(formFlag({ enabled: 'false' }, 'enabled'), false);
  assert.deepEqual(formList({ scopes: ['bot_report.read', 'offline_access'] }, 'scopes'), [
    'bot_report.read',
    'offline_access',
  ]);
  assert.deepEqual(formList({ scopes: 'bot_report.read,offline_access' }, 'scopes'), [
    'bot_report.read',
    'offline_access',
  ]);
});
void test('form contract rejects objects, nested arrays, numbers, and inherited fields', () => {
  for (const invalid of [123, ['x', {}], { value: 'x' }, true]) {
    assert.throws(() => formString({ name: invalid }, 'name'), InvalidFormField);
    assert.throws(() => formList({ scopes: invalid }, 'scopes'), InvalidFormField);
  }
  assert.throws(() => formString({ name: [] }, 'name'), InvalidFormField);
  assert.deepEqual(formList({ scopes: [] }, 'scopes'), []);
  assert.equal(formString(Object.create({ name: 'inherited' }) as unknown, 'name'), '');
});
void test('domain errors preserve safe Error metadata without trusting arbitrary values', () => {
  assert.deepEqual(routeError({ code: { bad: true }, status: 200, message: ['bad'] }), {
    code: undefined,
    status: undefined,
    message: 'Request failed',
  });
  const error = Object.assign(new Error('Invalid form'), {
    code: 'INVALID_FORM_FIELD',
    status: 400,
  });
  assert.deepEqual(routeError(error), {
    code: 'INVALID_FORM_FIELD',
    status: 400,
    message: 'Invalid form',
  });
  assert.deepEqual(routeError('unexpected'), { message: 'Request failed' });
});
