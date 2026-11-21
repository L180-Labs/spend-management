import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalLogin } from './local-login';
import { login, storeUser } from '@/lib/auth';

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/lib/auth', () => ({ login: jest.fn(), storeUser: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

it('uses password authentication and opens the dashboard after success', async () => {
  const user = { id: 'local', email: 'developer@example.test' };
  (login as jest.Mock).mockResolvedValue(user);
  render(<LocalLogin />);
  await userEvent.type(screen.getByLabelText('Password'), 'test-password-123');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in locally' }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
  expect(login).toHaveBeenCalledWith('developer@example.test', 'test-password-123');
  expect(storeUser).toHaveBeenCalledWith(user);
});

it('keeps invalid credentials on the form and allows retry', async () => {
  (login as jest.Mock).mockRejectedValue(new Error('Invalid credentials'));
  render(<LocalLogin />);
  await userEvent.type(screen.getByLabelText('Password'), 'incorrect');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in locally' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(mockReplace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sign in locally' })).toBeEnabled();
});
