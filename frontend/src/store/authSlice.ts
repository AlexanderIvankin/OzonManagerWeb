import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api';
import { User } from '../types';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  accessToken: localStorage.getItem('accessToken'),
  isLoading: false,
  error: null,
};

export const login = createAsyncThunk(
  'auth/login',
  async ({ usernameOrEmail, password }: { usernameOrEmail: string; password: string }) => {
    const response = await api.post('/auth/login', { usernameOrEmail, password });
    return response.data; // { user, accessToken, refreshToken }
  }
);

export const register = createAsyncThunk(
  'auth/register',
  async (userData: any) => {
    const response = await api.post('/auth/register', userData);
    return response.data;
  }
);

export const logout = createAsyncThunk('auth/logout', async (_, { getState }) => {
  const state = getState() as any;
  const refreshToken = state.auth.refreshToken;
  if (refreshToken) {
    await api.post('/auth/logout', { refreshToken });
  }
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
        localStorage.setItem('accessToken', action.payload.accessToken);
        localStorage.setItem('refreshToken', action.payload.refreshToken);
      })
      .addCase(login.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Login failed';
      })
      .addCase(register.fulfilled, (state, action) => {
        // После регистрации пользователь ещё не авторизован – просто показываем сообщение
      })
      .addCase(logout.fulfilled, (state) => {
        state.user = null;
        state.accessToken = null;
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
      });
  },
});

export default authSlice.reducer;