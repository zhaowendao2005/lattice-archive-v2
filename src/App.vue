<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useArchiveStore } from './stores/archive';
import { dbService } from './services/database';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import {
  Database,
  Search,
  Plus,
  Trash2,
  Cpu,
  FolderArchive,
  Terminal,
  Activity,
  Layers,
  Sparkles,
} from 'lucide-vue-next';

const store = useArchiveStore();

// Form state
const showAddModal = ref(false);
const newTitle = ref('');
const newCategory = ref('Research');
const newContent = ref('');
const newTags = ref('');

// SQL Query Console state
const showConsole = ref(false);
const sqlQuery = ref('SELECT id, title, category, created_at FROM archives LIMIT 5;');
const sqlResult = ref<string>('');
const isExecutingSql = ref(false);

onMounted(async () => {
  await store.fetchPlatformInfo();
  await store.loadArchives();
});

async function handleCreateArchive() {
  if (!newTitle.value.trim()) return;

  const tagsArray = newTags.value
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const ok = await store.addArchive({
    title: newTitle.value.trim(),
    category: newCategory.value.trim() || 'General',
    content: newContent.value.trim(),
    tags: tagsArray,
  });

  if (ok) {
    newTitle.value = '';
    newContent.value = '';
    newTags.value = '';
    showAddModal.value = false;
  }
}

async function executeCustomSql() {
  isExecutingSql.value = true;
  try {
    const res = await dbService.rawQuery(sqlQuery.value);
    sqlResult.value = JSON.stringify(res, null, 2);
  } catch (err: any) {
    sqlResult.value = JSON.stringify({ error: err.message }, null, 2);
  } finally {
    isExecutingSql.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
    <!-- Top Navigation / Header -->
    <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-40">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Layers class="h-5 w-5 text-white" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                Lattice Archive
              </span>
              <Badge variant="outline" class="border-indigo-500/40 text-indigo-400 bg-indigo-500/10 text-xs">
                Capacitor + Electron
              </Badge>
            </div>
            <p class="text-xs text-slate-400 hidden sm:block">
              Vue 3 · shadcn · Tailwind CSS · Pinia · Better-SQLite3
            </p>
          </div>
        </div>

        <!-- Right action: Platform info badge & new record -->
        <div class="flex items-center gap-3">
          <Badge
            :class="store.platformInfo?.isElectron ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30'"
            class="hidden md:inline-flex items-center gap-1.5 px-3 py-1"
          >
            <span class="h-2 w-2 rounded-full" :class="store.platformInfo?.isElectron ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'"></span>
            {{ store.platformInfo?.isElectron ? 'Electron + better-sqlite3' : 'Browser Mode (Fallback)' }}
          </Badge>

          <Button
            variant="outline"
            size="sm"
            class="border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-300"
            @click="showConsole = !showConsole"
          >
            <Terminal class="h-4 w-4 mr-1.5 text-indigo-400" />
            SQL Console
          </Button>

          <Button
            size="sm"
            class="bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30"
            @click="showAddModal = true"
          >
            <Plus class="h-4 w-4 mr-1.5" />
            新建归档
          </Button>
        </div>
      </div>
    </header>

    <!-- Main Container -->
    <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <!-- Status Cards -->
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card class="bg-slate-900/50 border-slate-800">
          <CardHeader class="pb-2">
            <CardDescription class="text-slate-400 text-xs flex items-center justify-between">
              归档记录总量
              <FolderArchive class="h-4 w-4 text-indigo-400" />
            </CardDescription>
            <CardTitle class="text-2xl font-bold text-slate-100">
              {{ store.archives.length }}
            </CardTitle>
          </CardHeader>
          <CardContent class="text-xs text-slate-400 pt-0">
            已存储于本地 SQLite 数据库
          </CardContent>
        </Card>

        <Card class="bg-slate-900/50 border-slate-800">
          <CardHeader class="pb-2">
            <CardDescription class="text-slate-400 text-xs flex items-center justify-between">
              数据库驱动
              <Database class="h-4 w-4 text-emerald-400" />
            </CardDescription>
            <CardTitle class="text-lg font-semibold text-emerald-400">
              {{ store.platformInfo?.isElectron ? 'better-sqlite3 (WAL)' : 'localStorage Proxy' }}
            </CardTitle>
          </CardHeader>
          <CardContent class="text-xs text-slate-400 pt-0 truncate" :title="store.platformInfo?.dbPath">
            {{ store.platformInfo?.dbPath || 'Initializing...' }}
          </CardContent>
        </Card>

        <Card class="bg-slate-900/50 border-slate-800">
          <CardHeader class="pb-2">
            <CardDescription class="text-slate-400 text-xs flex items-center justify-between">
              运行环境运行时
              <Cpu class="h-4 w-4 text-cyan-400" />
            </CardDescription>
            <CardTitle class="text-sm font-medium text-slate-200">
              Node: {{ store.platformInfo?.versions?.node || 'N/A' }}
            </CardTitle>
          </CardHeader>
          <CardContent class="text-xs text-slate-400 pt-0">
            Electron {{ store.platformInfo?.versions?.electron || 'Web' }}
          </CardContent>
        </Card>

        <Card class="bg-slate-900/50 border-slate-800">
          <CardHeader class="pb-2">
            <CardDescription class="text-slate-400 text-xs flex items-center justify-between">
              前端状态架构
              <Activity class="h-4 w-4 text-purple-400" />
            </CardDescription>
            <CardTitle class="text-sm font-medium text-slate-200">
              Pinia Store + shadcn
            </CardTitle>
          </CardHeader>
          <CardContent class="text-xs text-slate-400 pt-0">
            响应式状态流与模块解耦
          </CardContent>
        </Card>
      </div>

      <!-- SQL Console drawer / box if opened -->
      <div v-if="showConsole" class="rounded-xl border border-indigo-900/50 bg-slate-900/90 p-4 shadow-xl space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm font-semibold text-indigo-400">
            <Terminal class="h-4 w-4" />
            SQLite 实时查询控制台 (IPC Bridge)
          </div>
          <Button size="xs" variant="ghost" class="text-slate-400 hover:text-white" @click="showConsole = false">
            关闭
          </Button>
        </div>
        <div class="flex gap-2">
          <Input
            v-model="sqlQuery"
            placeholder="输入 SQL 语句, 如: SELECT * FROM archives;"
            class="bg-slate-950 border-slate-800 font-mono text-xs text-slate-200 flex-1"
          />
          <Button
            size="sm"
            class="bg-indigo-600 hover:bg-indigo-500 text-white shrink-0"
            :disabled="isExecutingSql"
            @click="executeCustomSql"
          >
            执行
          </Button>
        </div>
        <pre v-if="sqlResult" class="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-emerald-400 max-h-48 overflow-y-auto whitespace-pre-wrap">{{ sqlResult }}</pre>
      </div>

      <!-- Search & Category Filters -->
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <!-- Categories tabs -->
        <div class="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          <Button
            v-for="cat in store.categories"
            :key="cat"
            size="sm"
            :variant="store.selectedCategory === cat ? 'default' : 'ghost'"
            :class="store.selectedCategory === cat ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'"
            class="rounded-full px-3.5 text-xs transition-colors"
            @click="store.selectedCategory = cat"
          >
            {{ cat }}
          </Button>
        </div>

        <!-- Search input -->
        <div class="relative w-full sm:w-72">
          <Search class="h-4 w-4 absolute left-3 top-2.5 text-slate-500" />
          <Input
            v-model="store.searchQuery"
            placeholder="搜索标题、内容或标签..."
            class="pl-9 bg-slate-900 border-slate-800 text-sm text-slate-200 placeholder:text-slate-500 focus-visible:ring-indigo-500"
          />
        </div>
      </div>

      <!-- Archives Grid -->
      <div v-if="store.loading && store.archives.length === 0" class="text-center py-16 text-slate-400">
        <div class="animate-spin h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto mb-3"></div>
        正在加载本地归档数据...
      </div>

      <div v-else-if="store.filteredArchives.length === 0" class="rounded-2xl border border-dashed border-slate-800 p-12 text-center text-slate-500">
        <FolderArchive class="h-10 w-10 mx-auto mb-3 text-slate-600" />
        <p class="text-sm font-medium">暂无匹配的归档记录</p>
        <p class="text-xs text-slate-600 mt-1">尝试更换筛选分类或点击右上角创建一条新的归档</p>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        <Card
          v-for="item in store.filteredArchives"
          :key="item.id"
          class="bg-slate-900/60 border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between group shadow-sm hover:shadow-indigo-950/20"
        >
          <CardHeader class="pb-3">
            <div class="flex items-start justify-between gap-2">
              <Badge variant="outline" class="border-indigo-500/30 text-indigo-400 bg-indigo-500/10 text-[11px]">
                {{ item.category }}
              </Badge>
              <span class="text-[11px] font-mono text-slate-500">#{{ item.id }}</span>
            </div>
            <CardTitle class="text-base font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors pt-1">
              {{ item.title }}
            </CardTitle>
            <CardDescription class="text-xs text-slate-400 line-clamp-3">
              {{ item.content || '无详细内容描述。' }}
            </CardDescription>
          </CardHeader>

          <CardFooter class="pt-0 flex items-center justify-between border-t border-slate-800/60 mt-3 pt-3">
            <!-- Tags -->
            <div class="flex flex-wrap gap-1">
              <span
                v-for="tag in item.tags"
                :key="tag"
                class="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full"
              >
                #{{ tag }}
              </span>
            </div>

            <!-- Actions -->
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors ml-auto"
              @click="store.removeArchive(item.id)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    </main>

    <!-- Modal: Create Archive -->
    <div
      v-if="showAddModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in"
    >
      <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div class="flex items-center gap-2">
            <Sparkles class="h-5 w-5 text-indigo-400" />
            <h3 class="text-lg font-semibold text-slate-100">新增档案数据</h3>
          </div>
          <Button variant="ghost" size="xs" class="text-slate-400 hover:text-white" @click="showAddModal = false">
            ✕
          </Button>
        </div>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">标题</label>
            <Input
              v-model="newTitle"
              placeholder="例如：晶格能级常数测定"
              class="bg-slate-950 border-slate-800 text-sm"
            />
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">分类</label>
            <Input
              v-model="newCategory"
              placeholder="例如：Research, Design, Experiment..."
              class="bg-slate-950 border-slate-800 text-sm"
            />
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">内容描述</label>
            <textarea
              v-model="newContent"
              rows="3"
              placeholder="详细记录内容..."
              class="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            ></textarea>
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">标签 (逗号分隔)</label>
            <Input
              v-model="newTags"
              placeholder="lattice, physics, v2..."
              class="bg-slate-950 border-slate-800 text-sm"
            />
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
          <Button
            variant="ghost"
            size="sm"
            class="text-slate-400 hover:text-slate-200"
            @click="showAddModal = false"
          >
            取消
          </Button>
          <Button
            size="sm"
            class="bg-indigo-600 hover:bg-indigo-500 text-white"
            @click="handleCreateArchive"
          >
            保存入库 (SQLite)
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
