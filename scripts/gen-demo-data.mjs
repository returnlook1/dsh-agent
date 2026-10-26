#!/usr/bin/env node
/**
 * 生成演示业务数据：监测站、数据集与最近 30 天的监测序列。
 *
 * 数据是**确定性**的（用站名做种子的 xorshift PRNG），因此同一份代码总是生成同一份
 * 数据，便于测试断言与回归对比。真实部署时应替换为业务系统导出的数据。
 *
 * 用法：node scripts/gen-demo-data.mjs [--out runtime/tools]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outArgIndex = process.argv.indexOf('--out')
const outDir = path.resolve(
  root,
  outArgIndex > -1 ? process.argv[outArgIndex + 1] ?? 'runtime/tools' : 'runtime/tools',
)

/** 稳定 32 位字符串哈希（FNV-1a），用于播种。 */
function hashSeed(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** xorshift32 PRNG：确定性、无依赖。 */
function createRandom(seed) {
  let state = seed || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

const stations = [
  {
    id: 'ST-3101',
    name: '东湖一号监测站',
    region: '东湖流域',
    river: '东湖',
    type: '水质',
    datasetIds: ['water-quality'],
  },
  {
    id: 'ST-3102',
    name: '南湖入湖口监测站',
    region: '南湖流域',
    river: '南湖',
    type: '水质',
    datasetIds: ['water-quality'],
  },
  {
    id: 'ST-3103',
    name: '汤逊湖中心监测站',
    region: '汤逊湖流域',
    river: '汤逊湖',
    type: '水质',
    datasetIds: ['water-quality'],
  },
  {
    id: 'ST-4101',
    name: '汉江蔡甸断面',
    region: '汉江流域',
    river: '汉江',
    type: '水质',
    datasetIds: ['water-quality', 'hydrology'],
  },
  {
    id: 'ST-4102',
    name: '府河李家墩断面',
    region: '府河流域',
    river: '府河',
    type: '水质',
    datasetIds: ['water-quality', 'hydrology'],
  },
  {
    id: 'ST-5101',
    name: '梁子湖湖心监测站',
    region: '梁子湖流域',
    river: '梁子湖',
    type: '水质',
    datasetIds: ['water-quality'],
  },
]

const datasets = [
  {
    id: 'water-quality',
    name: '地表水水质监测数据',
    description: '国家地表水监测断面逐日水质指标（pH、溶解氧、高锰酸盐指数、氨氮、总磷、浊度）。',
    tags: ['水质', '地表水', '逐日'],
    granularity: 'day',
    unitNote: 'pH 无量纲；溶解氧 mg/L；其余 mg/L；浊度 NTU。',
    indicators: ['ph', 'dissolvedOxygen', 'codmn', 'ammoniaNitrogen', 'totalPhosphorus', 'turbidity'],
    coverageYears: [2021, 2026],
  },
  {
    id: 'hydrology',
    name: '水文监测数据',
    description: '河道断面逐日水位、流量与水温。',
    tags: ['水文', '流量', '水位'],
    granularity: 'day',
    unitNote: '水位 m；流量 m³/s；水温 ℃。',
    indicators: ['waterLevel', 'flow', 'waterTemperature'],
    coverageYears: [2022, 2026],
  },
  {
    id: 'algal-bloom',
    name: '蓝藻水华监测数据',
    description: '湖库叶绿素 a 与藻密度观测，用于水华预警评估。',
    tags: ['水华', '叶绿素', '预警'],
    granularity: 'week',
    unitNote: '叶绿素 a μg/L；藻密度 万个/L。',
    indicators: ['chlorophyllA', 'algaeDensity'],
    coverageYears: [2023, 2026],
  },
  {
    id: 'station-meta',
    name: '监测站基础信息',
    description: '监测站编码、名称、所属流域与监测类型。',
    tags: ['站点', '基础信息'],
    granularity: 'static',
    unitNote: '',
    indicators: ['region', 'river', 'type'],
    coverageYears: [2020, 2026],
  },
  {
    id: 'emission-permit',
    name: '排污许可与排放口信息',
    description: '流域内重点排污单位许可排放量与排放口位置（仅授权用户可见）。',
    tags: ['排污许可', '排放口', '受限'],
    granularity: 'static',
    unitNote: '排放量 t/a。',
    indicators: ['permitId', 'outfallLongitude', 'outfallLatitude', 'allowedDischarge'],
    coverageYears: [2024, 2026],
    restricted: true,
  },
]

const DAY = 24 * 60 * 60 * 1000
/** 固定"数据截止日"，保证生成结果与运行时间无关。 */
const END_DATE = Date.UTC(2026, 9, 25) // 2026-10-25

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const series = {}
for (const station of stations) {
  const random = createRandom(hashSeed(station.id))
  const records = []
  for (let offset = 29; offset >= 0; offset -= 1) {
    const time = END_DATE - offset * DAY
    const date = new Date(time).toISOString().slice(0, 10)
    records.push({
      date,
      ph: round(7.1 + random() * 1.1, 2),
      dissolvedOxygen: round(5.6 + random() * 3.2, 2),
      codmn: round(2.1 + random() * 3.4, 2),
      ammoniaNitrogen: round(0.08 + random() * 0.72, 3),
      totalPhosphorus: round(0.02 + random() * 0.11, 3),
      turbidity: round(4 + random() * 26, 1),
      ...(station.datasetIds.includes('hydrology')
        ? {
            waterLevel: round(18.2 + random() * 2.6, 2),
            flow: round(420 + random() * 380, 1),
            waterTemperature: round(16.4 + random() * 6.2, 1),
          }
        : {}),
    })
  }
  series[station.id] = records
}

mkdirSync(outDir, { recursive: true })

writeFileSync(
  path.join(outDir, 'datasets.json'),
  `${JSON.stringify({ generatedAt: new Date(END_DATE).toISOString(), datasets }, null, 2)}\n`,
  'utf8',
)

// stations.json 的数据契约由 plugins/agent-tools 定义：
//   顶层 { stations: [{ id, name, readings: [{ day, value }] }] }
// `value` 是该站的代表指标（水质站用溶解氧 mg/L，工具只读这一个字段）。
// 每条 reading 额外带一个 `indicators` 对象保存全部指标，供前端/后续工具使用；
// 加载器只取 day/value，额外字段不会影响校验。
const stationRecords = stations.map((station) => {
  const records = series[station.id]
  return {
    ...station,
    readings: records.map((record) => {
      const { date, dissolvedOxygen, ...indicators } = record
      return { day: date, value: dissolvedOxygen, indicators }
    }),
  }
})

writeFileSync(
  path.join(outDir, 'stations.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date(END_DATE).toISOString(),
      period: {
        from: new Date(END_DATE - 29 * DAY).toISOString().slice(0, 10),
        to: new Date(END_DATE).toISOString().slice(0, 10),
      },
      stations: stationRecords,
    },
    null,
    2,
  )}\n`,
  'utf8',
)

process.stdout.write(
  `wrote ${datasets.length} datasets, ${stations.length} stations, ${stations.length * 30} daily records to ${outDir}\n`,
)
