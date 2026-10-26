/**
 * 轻量线性图标（24×24，stroke=currentColor）。
 * 不引入图标字体依赖，避免额外体积与版本风险。
 */
import { defineComponent, h } from 'vue'

function createIcon(name: string, paths: readonly string[]) {
  return defineComponent({
    name,
    setup() {
      return () =>
        h(
          'svg',
          {
            xmlns: 'http://www.w3.org/2000/svg',
            viewBox: '0 0 24 24',
            width: '1em',
            height: '1em',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1.8,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          paths.map((d) => h('path', { d })),
        )
    },
  })
}

export const IconAgents = createIcon('IconAgents', [
  'M4 4h6.5v6.5H4z',
  'M13.5 4H20v6.5h-6.5z',
  'M4 13.5h6.5V20H4z',
  'M13.5 13.5H20V20h-6.5z',
])

export const IconChat = createIcon('IconChat', [
  'M20 12.4c0 4-3.6 7.2-8 7.2-1 0-2-.2-2.9-.5L4.5 21l1.2-3.6C4.3 16.1 3.5 14.4 3.5 12.4c0-4 3.6-7.2 8-7.2s8.5 3.2 8.5 7.2z',
])

export const IconMcp = createIcon('IconMcp', [
  'M4 5.5h16V11H4z',
  'M4 13h16v5.5H4z',
  'M7.5 8.25h.01',
  'M7.5 15.75h.01',
])

export const IconAudit = createIcon('IconAudit', [
  'M6 3.5h9l3 3v14H6z',
  'M9 9h6',
  'M9 12.5h6',
  'M9 16h4',
])

export const IconPlus = createIcon('IconPlus', ['M12 5v14', 'M5 12h14'])
export const IconRefresh = createIcon('IconRefresh', [
  'M20 11.5A8 8 0 1 0 17.6 17.6',
  'M20 4.5v6h-6',
])
export const IconSend = createIcon('IconSend', ['M4 12 20 4l-6 16-3-6-7-2z'])
export const IconStop = createIcon('IconStop', ['M7 7h10v10H7z'])
export const IconBack = createIcon('IconBack', ['M15 19l-7-7 7-7'])
export const IconLogout = createIcon('IconLogout', [
  'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3',
  'M4 12h11',
  'M12 8l4 4-4 4',
])
export const IconTool = createIcon('IconTool', ['M14 7.5a3.5 3.5 0 0 1 4.9 4.4L10.5 20.3 5 15l8.5-8.5', 'M7.5 8.5l2 2'])
export const IconCheck = createIcon('IconCheck', ['M5 12.5l4.5 4.5L19 6.5'])
export const IconClose = createIcon('IconClose', ['M6 6l12 12', 'M18 6 6 18'])
export const IconClock = createIcon('IconClock', [
  'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  'M12 7.5V12l3 1.8',
])
export const IconShield = createIcon('IconShield', [
  'M12 3.2l7 2.8v5.6c0 4.4-3 8.2-7 9.2-4-1-7-4.8-7-9.2V6l7-2.8z',
  'M9 12l2.2 2.2L15.5 10',
])
export const IconSliders = createIcon('IconSliders', [
  'M4 7h16',
  'M4 12.5h16',
  'M4 18h16',
  'M9 4.5V9.5',
  'M15 10v5',
  'M7.5 15.5v5',
])
export const IconDatabase = createIcon('IconDatabase', [
  'M12 3.2c4.3 0 7.5 1.2 7.5 2.8S16.3 8.8 12 8.8 4.5 7.6 4.5 6s3.2-2.8 7.5-2.8z',
  'M4.5 6v12c0 1.6 3.2 2.8 7.5 2.8s7.5-1.2 7.5-2.8V6',
  'M4.5 12c0 1.6 3.2 2.8 7.5 2.8s7.5-1.2 7.5-2.8',
])
export const IconWarning = createIcon('IconWarning', ['M12 4l8.5 15.5h-17z', 'M12 9.5v4', 'M12 16.5h.01'])
export const IconSearch = createIcon('IconSearch', [
  'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z',
  'M16.5 16.5 21 21',
])
export const IconTrash = createIcon('IconTrash', ['M4.5 7h15', 'M9.5 7V4.8h5V7', 'M6.5 7l1 12.5h9L17.5 7'])
export const IconEdit = createIcon('IconEdit', ['M4 20h4l10.5-10.5-4-4L4 16v4z', 'M13.5 6.5l4 4'])
export const IconChevronRight = createIcon('IconChevronRight', ['M9 5.5l6.5 6.5L9 18.5'])
export const IconPlay = createIcon('IconPlay', ['M8 5l11 7-11 7V5z'])
export const IconExternal = createIcon('IconExternal', ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'])
export const IconHistory = createIcon('IconHistory', [
  'M4 12a8 8 0 1 0 2.4-5.7',
  'M4 4.5v5h5',
  'M12 8.5V12l3 1.8',
])
export const IconArrowUpRight = createIcon('IconArrowUpRight', ['M7 17 17 7', 'M9 7h8v8'])
