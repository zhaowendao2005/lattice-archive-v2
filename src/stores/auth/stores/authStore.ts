import { defineStore } from 'pinia';

export type AuthMode = 'login' | 'register' | 'forgot';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: string;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    isModalOpen: false,
    mode: 'login' as AuthMode,
    emailInput: 'architect@lattice.dev',
    passwordInput: '••••••••••••',
    user: {
      id: 'usr_1',
      name: 'Elena Rostova',
      email: 'elena@lattice.dev',
      initials: 'EL',
      role: 'Core Architect',
    } as UserProfile | null,
  }),

  actions: {
    openModal(mode: AuthMode = 'login') {
      this.mode = mode;
      this.isModalOpen = true;
    },

    closeModal() {
      this.isModalOpen = false;
    },

    setMode(mode: AuthMode) {
      this.mode = mode;
    },

    submitAuth() {
      this.user = {
        id: 'usr_1',
        name: 'Elena Rostova',
        email: this.emailInput || 'elena@lattice.dev',
        initials: 'EL',
        role: 'Core Architect',
      };
      this.closeModal();
    },

    logout() {
      this.user = null;
    },
  },
});
