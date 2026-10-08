<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';

const authStore = useAuthStore();
</script>

<template>
  <div class="space-y-4">
    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">用户名</span>
      <Input type="text" placeholder="例如：Elena" class="token-control-height px-3" />
    </label>

    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">邮箱</span>
      <Input type="email" placeholder="name@domain.com" class="token-control-height px-3" />
    </label>

    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">设置密码</span>
      <Input type="password" placeholder="至少 8 位，包含数字与字母" class="token-control-height px-3" />
    </label>

    <Button class="w-full token-control-height hover:bg-primary/90" @click="authStore.submitAuth()">
      创建账号并登录
    </Button>

    <p class="text-center text-[13px] text-muted-foreground">
      已有账号？
      <button type="button" class="font-medium text-foreground hover:underline" @click="authStore.setMode('login')">
        直接登录
      </button>
    </p>
  </div>
</template>
