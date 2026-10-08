<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';

const authStore = useAuthStore();
</script>

<template>
  <div class="space-y-4">
    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">邮箱或账号</span>
      <Input v-model="authStore.emailInput" type="text" class="token-control-height px-3" />
    </label>

    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">密码</span>
      <Input v-model="authStore.passwordInput" type="password" class="token-control-height px-3" />
    </label>

    <Button class="w-full token-control-height hover:bg-primary/90" @click="authStore.submitAuth()">
      登录
    </Button>

    <div class="flex items-center justify-between text-[13px] text-muted-foreground">
      <button type="button" class="hover:text-foreground transition-colors" @click="authStore.setMode('forgot')">
        忘记密码？
      </button>
      <button type="button" class="hover:text-foreground transition-colors" @click="authStore.setMode('register')">
        注册新账号
      </button>
    </div>
  </div>
</template>
