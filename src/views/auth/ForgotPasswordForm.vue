<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';

const authStore = useAuthStore();
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground leading-relaxed">
      输入注册邮箱，我们会向该邮箱发送重置链接。
    </p>

    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-muted-foreground">注册邮箱</span>
      <Input type="email" placeholder="name@domain.com" class="token-control-height px-3" />
    </label>

    <Button class="w-full token-control-height hover:bg-primary/90" @click="authStore.setMode('login')">
      发送验证邮件
    </Button>

    <button
      type="button"
      class="block mx-auto text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      @click="authStore.setMode('login')"
    >
      返回登录
    </button>
  </div>
</template>
