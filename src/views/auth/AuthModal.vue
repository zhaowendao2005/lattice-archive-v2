<script setup lang="ts">
import { X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAuthStore, type AuthMode } from '@/stores/auth/stores/authStore';
import LoginForm from './LoginForm.vue';
import RegisterForm from './RegisterForm.vue';
import ForgotPasswordForm from './ForgotPasswordForm.vue';

const authStore = useAuthStore();

const TITLES: Record<AuthMode, string> = {
  login: '登录',
  register: '创建账号',
  forgot: '找回密码',
};
</script>

<template>
  <div
    v-if="authStore.isModalOpen"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="authStore.closeModal()"
  >
    <div role="dialog" aria-modal="true" class="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-base font-semibold tracking-tight">{{ TITLES[authStore.mode] }}</h2>
        <Button variant="ghost" size="icon" class="-mr-2 text-muted-foreground" aria-label="关闭" @click="authStore.closeModal()">
          <X :stroke-width="1.75" />
        </Button>
      </div>

      <LoginForm v-if="authStore.mode === 'login'" />
      <RegisterForm v-else-if="authStore.mode === 'register'" />
      <ForgotPasswordForm v-else-if="authStore.mode === 'forgot'" />
    </div>
  </div>
</template>
