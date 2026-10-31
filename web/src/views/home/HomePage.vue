<script setup>
/** 工作台：聚合真实创作数据、近期作品、任务状态与模板推荐。 */
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { api } from '../../api/client'
import { dateLabel, statusLabel } from '../../shared/format'
import { reportError } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import EmptyState from '../../components/EmptyState.vue'
import StoryCard from '../../components/StoryCard.vue'
import { useReactions } from '../../shared/useReactions'
const router = useRouter(),
  reactions = useReactions(),
  auth = useAuth(),
  stats = ref({ scripts: 0, words: 0, favorites: 0, days: 0 }),
  scripts = ref([]),
  templates = ref([]),
  jobs = ref([]),
  busy = ref(false),
  error = ref('')
const summary = computed(() => [
  {
    name: '我的剧本',
    value: stats.value.scripts,
    unit: '部',
    icon: 'Document',
    note: '每一部，都是新的世界'
  },
  {
    name: '已创作字数',
    value: stats.value.words.toLocaleString(),
    unit: '字',
    icon: 'EditPen',
    note: '把想象变成文字'
  },
  { name: '我的收藏', value: stats.value.favorites, unit: '个', icon: 'Star', note: '收集心动的灵感' },
  { name: '创作天数', value: stats.value.days, unit: '天', icon: 'Calendar', note: '保持热爱，持续落笔' }
])
const greeting = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date())) < 12 ? '上午好' : '下午好'

/**
 * 并行读取个人统计、近期作品、热门模板及 AI 任务，组成创作工作台数据。
 */
async function load() {
  busy.value = true
  error.value = ''
  try {
    const [s, l, t, j] = await Promise.all([api('/me/stats'), api('/scripts?size=3'), api('/templates?size=4&sort=hot'), api('/ai/jobs')])
    stats.value = s
    scripts.value = l.items
    templates.value = t.items
    jobs.value = j.slice(0, 3)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

/**
 * 收藏模板后刷新个人统计，使工作台收藏数量与后端一致。
 */
async function favorite(t) {
  try {
    if (await reactions.toggleFavorite(t, 'template')) stats.value = await api('/me/stats')
  } catch (e) {
    reportError(e)
  }
}
onMounted(load)
</script>
<template>
  <div v-loading="busy">
    <PageHeading :title="greeting + '，' + auth.user.nickname" icon="Sunny" description="捕捉此刻的灵感，让好故事从这里发生。" eyebrow="YOUR NEXT STORY STARTS HERE">
      <span class="date-label">
        {{
          new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
          }).format(new Date())
        }}
        <br />
        <span>宜 · 写一个好故事</span>
      </span>
    </PageHeading>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"><el-button text @click="load">重试</el-button></el-alert>
    <el-alert
      v-if="!auth.capabilities.aiConfigured"
      class="setup-notice"
      title="创作空间已就绪 · 填写 DeepSeek Key 后即可使用 AI"
      description="请从左侧 API 配置填写你自己的 Key；也可以先手动创作与管理剧本。"
      type="info"
      :closable="false"
      show-icon />
    <div class="hero">
      <div class="hero-text">
        <span class="hero-kicker">
          <el-icon aria-hidden="true"><MagicStick /></el-icon>
          你的 AI 编剧搭档
        </span>
        <h2>
          灵感落笔，
          <br />
          让每一幕都有故事。
        </h2>
        <p>
          从一个念头到完整剧本，和 AI 一起，
          <br />
          写出角色的温度、情节的张力，还有你的表达。
        </p>
        <el-button type="primary" size="large" @click="router.push('/create')">
          <el-icon aria-hidden="true"><MagicStick /></el-icon>
          开始创作新剧本
          <el-icon class="inline-icon" aria-hidden="true"><TopRight /></el-icon>
        </el-button>
      </div>
      <div class="hero-art">
        <span class="orbit o1"></span>
        <span class="orbit o2"></span>
        <span class="spark s1" aria-hidden="true">
          <el-icon><Star /></el-icon>
        </span>
        <span class="spark s2" aria-hidden="true">
          <el-icon><MagicStick /></el-icon>
        </span>
        <div class="paper back"></div>
        <div class="paper front">
          <div class="paper-label">ORIGINAL STORY</div>
          <h3>
            每一个好故事
            <br />
            都始于一个「如果」
          </h3>
          <span class="paper-rule"></span>
          <p>场景 01　日 / 内</p>
          <div class="ink-line"></div>
          <div class="ink-line short"></div>
          <p class="paper-dialog">「这一次，我想自己选择。」</p>
          <div class="ink-line"></div>
          <span class="paper-end">THE STORY IS YOURS.</span>
        </div>
        <div class="clapper">
          <div class="clapper-top"></div>
          <b>
            SCENE
            <span>01</span>
          </b>
          <small>DIRECTED BY YOU</small>
        </div>
        <div class="art-note">
          a little spark,
          <br />
          <i>a whole new story.</i>
        </div>
      </div>
    </div>
    <div class="stats-row">
      <div v-for="(s, i) in summary" :key="s.name" class="stat">
        <span class="stat-icon" :class="'tone-' + i">
          <el-icon><component :is="s.icon" /></el-icon>
        </span>
        <div>
          <p>{{ s.name }}</p>
          <strong>
            {{ s.value }}
            <small>{{ s.unit }}</small>
          </strong>
          <span class="stat-note">{{ s.note }}</span>
        </div>
      </div>
    </div>
    <section>
      <div class="section-heading">
        <h2>
          继续创作
          <span>让未完的故事，接着发生</span>
        </h2>
        <button @click="router.push('/scripts')">
          全部剧本
          <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </button>
      </div>
      <EmptyState v-if="!scripts.length" title="你的第一部故事，从这里开始" description="创建空白剧本，或让 AI 帮你写下第一幕。">
        <el-button type="primary" @click="router.push('/scripts')">新建手写剧本</el-button>
      </EmptyState>
      <div v-else class="script-grid">
        <article v-for="s in scripts" :key="s.id" class="script-card" tabindex="0" @click="router.push('/scripts/' + s.id)" @keydown.enter="router.push('/scripts/' + s.id)">
          <div class="script-card-top">
            <span class="file-icon">
              <el-icon><Document /></el-icon>
            </span>
            <span class="status">{{ statusLabel(s) }}</span>
          </div>
          <h3>{{ s.title }}</h3>
          <div class="tag-line">
            <span>{{ s.genre }}</span>
            <span v-for="t in s.tags" :key="t">{{ t }}</span>
          </div>
          <p class="card-desc">{{ s.synopsis || '故事等待继续。' }}</p>
          <div class="card-meta">
            <span>{{ s.episode_count }} 集 · {{ s.words }} 字</span>
            <span>{{ dateLabel(s.updated_at) }}</span>
          </div>
          <div class="hover-edit">
            继续编辑
            <el-icon class="inline-icon" aria-hidden="true"><TopRight /></el-icon>
          </div>
        </article>
      </div>
    </section>
    <section>
      <div class="section-heading">
        <h2>
          从一个好模板开始
          <span>少一点空白页，多一点灵感</span>
        </h2>
        <button @click="router.push('/templates')">
          探索模板库
          <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </button>
      </div>
      <div class="template-grid home-templates">
        <StoryCard
          v-for="t in templates"
          :key="t.id"
          :item="t"
          :favorite-pending="reactions.pending.has('favorite:' + t.id)"
          @open="router.push('/templates?preview=' + t.id)"
          @apply="router.push('/create?template=' + t.id)"
          @favorite="favorite" />
      </div>
    </section>
    <section v-if="jobs.length" class="panel">
      <div class="section-heading">
        <h2>最近 AI 任务</h2>
        <button @click="router.push('/create')">
          继续创作
          <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </button>
      </div>
      <div v-for="j in jobs" :key="j.id" class="task-row">
        <span>{{ j.operation === 'generate' ? '多集剧本生成' : j.operation === 'optimize' ? '质量评估一键优化' : j.operation === 'evaluate' ? '剧本质量评估' : 'AI 文本打磨' }}</span>
        <el-tag :type="j.status === 'completed' ? 'success' : j.status === 'failed' ? 'danger' : 'info'">
          {{ { running: '生成中', completed: '已完成', failed: '失败，可重试', cancelled: '已停止' }[j.status] }}
        </el-tag>
        <span>{{ dateLabel(j.created_at) }}</span>
        <el-button v-if="j.script_id" text @click="router.push('/scripts/' + j.script_id)">打开已保存内容</el-button>
      </div>
    </section>
    <footer class="page-footer">
      <span>让创作回归故事本身。</span>
      <span>AI 辅助创作，请审阅生成内容。</span>
    </footer>
  </div>
</template>
