<script setup lang="ts">
import { VxeTable } from 'vxe-table/es/table';
import { VxeColumn } from 'vxe-table/es/column';
import { VxeUI } from 'vxe-table/es/ui';
import zhCN from 'vxe-table/es/locale/lang/zh-CN';
import 'vxe-table/lib/style.css';
import type { VxeTableDefines } from 'vxe-table';
import { Button } from '@/components/ui/button';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
const store = useAdminUsersStore();
if (!VxeUI.hasLanguage('zh-CN')) {
  VxeUI.setI18n('zh-CN', zhCN);
  VxeUI.setLanguage('zh-CN');
}
const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const handleSort = ({ field, order }: VxeTableDefines.SortChangeEventParams) => store.setSort(field, order);
</script>

<template>
  <VxeTable
    class="admin-users-table" :data="store.users" :loading="store.isLoading" border="inner" stripe show-overflow="title"
    height="480" :row-config="{ keyField: 'id', isHover: true }" :sort-config="{ remote: true }"
    empty-text="暂无匹配的普通用户" @sort-change="handleSort"
  >
    <VxeColumn field="name" title="用户名" min-width="160" sortable />
    <VxeColumn field="email" title="邮箱" min-width="240" sortable />
    <VxeColumn field="id" title="用户 ID" min-width="240" />
    <VxeColumn field="created_at" title="创建时间" width="190" sortable>
      <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
    </VxeColumn>
    <VxeColumn title="操作" width="100" fixed="right">
      <template #default="{ row }"><Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" :aria-label="`删除 ${row.email}`" @click="store.askDelete(row)">删除</Button></template>
    </VxeColumn>
    <template #loading><div class="flex h-full min-h-24 items-center justify-center bg-card/80 text-sm text-muted-foreground" role="status">正在加载用户…</div></template>
  </VxeTable>
</template>

<style>
.admin-users-table {
  --vxe-ui-font-family: var(--font-sans);
  --vxe-ui-font-color: var(--foreground);
  --vxe-ui-font-primary-color: var(--brand);
  --vxe-ui-layout-background-color: var(--card);
  --vxe-ui-table-border-color: var(--border);
  --vxe-ui-table-header-background-color: var(--muted);
  --vxe-ui-table-row-striped-background-color: var(--surface-sub);
  --vxe-ui-table-row-hover-background-color: var(--accent);
  --vxe-ui-table-row-hover-striped-background-color: var(--accent);
  --vxe-ui-font-darken-color: var(--muted-foreground);
  --vxe-ui-loading-background-color: var(--card);
  --vxe-ui-input-border-color: var(--input);
}
</style>
