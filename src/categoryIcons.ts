/**
 * categoryIcons.ts — 记账分类图标库
 *
 * 图标全部走 Obsidian 内置 Lucide（setIcon）。内置图标名随版本会改名/增删，
 * 所以每个图标给一组候选名（依次试，取第一个真正渲染出 svg 的），
 * 全部失败再退回分类名首字，不会留空白格子。
 *
 * 分类的 icon 字段存这里的 key；空 = 按分类名自动匹配（guessCategoryIcon）。
 */
import { setIcon } from "obsidian";

export interface CategoryIconDef {
  key: string;
  label: string;
  /** 候选 Lucide 图标名，依次尝试（新版改名时旧名兜底） */
  lucide: string[];
}

export interface CategoryIconGroup {
  title: string;
  items: CategoryIconDef[];
}

const it = (key: string, label: string, ...lucide: string[]): CategoryIconDef => ({ key, label, lucide });

/** 分组图标库（选择器按组分区展示；key 全库唯一） */
const GROUPS: CategoryIconGroup[] = [
  {
    title: "餐饮美食",
    items: [
      it("utensils", "餐饮", "utensils", "utensils-crossed"),
      it("coffee", "咖啡茶饮", "coffee", "cup-soda"),
      it("beer", "酒水", "beer", "wine"),
      it("cake", "甜品蛋糕", "cake", "cake-slice"),
      it("pizza", "西餐简餐", "pizza", "sandwich"),
      it("sandwich", "汉堡快餐", "sandwich", "pizza"),
      it("cookie", "零食饼干", "cookie", "candy"),
      it("candy", "糖果甜点", "candy", "lollipop"),
      it("icecream", "冰淇淋", "ice-cream-cone", "ice-cream"),
      it("fish", "海鲜水产", "fish", "shrimp"),
      it("egg", "蛋类早餐", "egg", "egg-fried"),
      it("apple", "水果生鲜", "apple", "cherry", "banana", "grape"),
      it("soup", "火锅汤煲", "soup", "cooking-pot"),
    ],
  },
  {
    title: "交通出行",
    items: [
      it("car", "汽车驾车", "car", "car-front"),
      it("taxi", "打车出租", "car-taxi-front", "car"),
      it("bus", "公交地铁", "bus", "bus-front"),
      it("train", "火车高铁", "train-front", "train"),
      it("plane", "飞机机票", "plane", "plane-takeoff"),
      it("ship", "轮船渡轮", "ship", "sailboat"),
      it("truck", "货运搬家", "truck"),
      it("fuel", "加油油费", "fuel", "gas-pump"),
      it("bike", "骑行单车", "bike"),
      it("parking", "停车费", "circle-parking", "square-parking", "car"),
      it("map", "出行导航", "map", "navigation", "compass"),
      it("luggage", "旅行行李", "luggage", "suitcase"),
    ],
  },
  {
    title: "购物消费",
    items: [
      it("cart", "购物日用", "shopping-cart", "shopping-basket"),
      it("shopping", "网购电商", "shopping-bag", "store"),
      it("shirt", "服饰鞋包", "shirt"),
      it("gem", "珠宝饰品", "gem", "diamond"),
      it("watch", "手表配饰", "watch"),
      it("glasses", "眼镜", "glasses"),
      it("package", "快递物流", "package", "box"),
      it("store", "商超便利", "store", "building"),
      it("tag", "优惠折扣", "tag", "tags", "percent"),
      it("gift", "礼物礼品", "gift"),
      it("ticket", "票务演出", "ticket"),
    ],
  },
  {
    title: "居家生活",
    items: [
      it("home", "住房房租", "house", "home"),
      it("bed", "床品住宿", "bed", "bed-double"),
      it("bath", "洗浴清洁", "bath", "shower-head"),
      it("sofa", "家具沙发", "sofa", "armchair"),
      it("lamp", "灯具照明", "lamp", "lamp-desk"),
      it("washing", "洗衣机", "washing-machine"),
      it("fridge", "冰箱", "refrigerator"),
      it("tv", "电视影音", "tv", "monitor"),
      it("phone", "手机数码", "smartphone", "tablet"),
      it("laptop", "电脑办公", "laptop", "monitor"),
      it("wifi", "网费宽带", "wifi", "router"),
      it("lightbulb", "水电照明", "lightbulb", "zap"),
      it("droplets", "水费燃气", "droplets", "flame"),
      it("wrench", "维修上门", "wrench", "hammer"),
    ],
  },
  {
    title: "文化娱乐",
    items: [
      it("gamepad", "游戏电竞", "gamepad-2", "gamepad"),
      it("film", "电影影音", "film", "clapperboard"),
      it("music", "音乐歌曲", "music", "audio-lines"),
      it("mic", "唱歌KTV", "mic", "mic-vocal"),
      it("headphones", "音频会员", "headphones", "headset"),
      it("camera", "摄影拍照", "camera"),
      it("palette", "绘画手作", "palette", "brush"),
      it("book", "图书阅读", "book", "book-open"),
      it("dumbbell", "健身运动", "dumbbell"),
      it("trophy", "比赛竞技", "trophy", "medal"),
    ],
  },
  {
    title: "医疗健康",
    items: [
      it("health", "医疗健康", "heart-pulse", "heart"),
      it("stethoscope", "看病门诊", "stethoscope"),
      it("pill", "药品保健", "pill"),
      it("syringe", "疫苗体检", "syringe"),
      it("hospital", "医院住院", "hospital", "cross"),
      it("baby", "母婴用品", "baby"),
      it("pet", "宠物", "dog", "cat", "pawprint"),
    ],
  },
  {
    title: "教育学习",
    items: [
      it("graduation", "学业教育", "graduation-cap"),
      it("study", "学习培训", "book-open", "notebook-pen"),
      it("pen", "文具用品", "pencil", "pen"),
      it("calculator", "考试报名", "calculator"),
      it("backpack", "书包学具", "backpack"),
    ],
  },
  {
    title: "人情社交",
    items: [
      it("handshake", "请客随礼", "heart-handshake", "handshake"),
      it("party", "红包庆祝", "party-popper"),
      it("heart", "慈善捐赠", "heart"),
      it("users", "聚餐聚会", "users", "user"),
    ],
  },
  {
    title: "收入理财",
    items: [
      it("salary", "工资薪资", "briefcase"),
      it("banknote", "现金收入", "banknote"),
      it("coins", "零钱积分", "coins"),
      it("piggy", "存款储蓄", "piggy-bank"),
      it("creditcard", "信用卡", "credit-card"),
      it("wallet", "钱包余额", "wallet"),
      it("bank", "银行利息", "landmark", "building-2"),
      it("receipt", "报销退款", "receipt", "receipt-text"),
      it("invest", "投资理财", "trending-up", "chart-line", "line-chart"),
      it("handcoins", "收款进账", "hand-coins", "hand-heart"),
      it("transfer", "转账还款", "arrow-left-right", "repeat"),
      it("percent", "税费手续费", "percent"),
    ],
  },
  {
    title: "通用",
    items: [
      it("star", "常用", "star"),
      it("sparkles", "其他杂项", "sparkles"),
      it("more", "更多", "ellipsis", "more-horizontal"),
      it("help", "待定", "circle-help", "help-circle"),
      it("building", "公司事务", "building", "building-2"),
      it("globe", "网络服务", "globe"),
    ],
  },
];

const BY_KEY: Map<string, CategoryIconDef> = new Map();
GROUPS.forEach(g => g.items.forEach(d => BY_KEY.set(d.key, d)));

/** 依次尝试候选图标名，取第一个真正渲染出 svg 的（Obsidian 内置集随版本增删） */
function setAnyIcon(el: HTMLElement, names: string[]): void {
  for (const name of names) {
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}

/** 画分类图标：库里没有或全渲染失败就退回分类名首字 */
export function renderCategoryIcon(el: HTMLElement, key: string, fallbackText: string): void {
  const def = key ? BY_KEY.get(key) : undefined;
  if (def) {
    el.empty();
    setAnyIcon(el, def.lucide);
    if (el.querySelector("svg")) return;
  }
  el.empty();
  el.setText((fallbackText || "?").trim().slice(0, 1));
}

/** 某个 key 是否还在库里 */
export function isKnownCategoryIcon(key: string): boolean {
  return BY_KEY.has(key);
}

/** 图标 key 的中文名（找不到给空串） */
export function categoryIconLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? "";
}

/** 选择器的全部分组 */
export function allCategoryIconGroups(): CategoryIconGroup[] {
  return GROUPS;
}

/** 按分类名猜图标（老配置没有 icon 字段时兜底；猜不出给空串 = 显示首字） */
const GUESS_RULES: { re: RegExp; key: string }[] = [
  { re: /餐|食|饭|吃|外卖|早点|宵夜|餐厅|食堂|三餐|下午茶/, key: "utensils" },
  { re: /咖啡|奶茶|饮品|茶|饮料|豆浆/, key: "coffee" },
  { re: /酒|酒吧|啤酒|白酒|红酒/, key: "beer" },
  { re: /蛋糕|甜品|甜点|烘焙|点心|面包/, key: "cake" },
  { re: /零食|小食|饼干|坚果/, key: "cookie" },
  { re: /水果|生鲜/, key: "apple" },
  { re: /海鲜|水产|鱼/, key: "fish" },
  { re: /火锅|汤|煲/, key: "soup" },
  { re: /买菜|菜市场/, key: "cart" },
  { re: /打车|出租|网约车|专车/, key: "taxi" },
  { re: /公交|地铁|通勤|交通/, key: "bus" },
  { re: /火车|高铁|动车|城铁/, key: "train" },
  { re: /飞机|机票|航空/, key: "plane" },
  { re: /船|轮渡|邮轮/, key: "ship" },
  { re: /加油|油费|油耗/, key: "fuel" },
  { re: /充电|电费|电瓶/, key: "lightbulb" },
  { re: /停车|车位/, key: "parking" },
  { re: /单车|骑行|共享/, key: "bike" },
  { re: /快递|包裹|物流|邮政/, key: "package" },
  { re: /购物|网购|电商|日用|百货/, key: "shopping" },
  { re: /超市|便利|商超/, key: "store" },
  { re: /衣服|服饰|鞋|穿搭|衣/, key: "shirt" },
  { re: /美妆|化妆|护肤|美容|理发|美发/, key: "sparkles" },
  { re: /话费|手机|通讯|宽带|网费|流量/, key: "phone" },
  { re: /房租|房贷|住房|物业|居住|家装|家居|装修/, key: "home" },
  { re: /住宿|酒店|民宿|宾馆/, key: "bed" },
  { re: /家电|电视|冰箱|洗衣机/, key: "tv" },
  { re: /家具|沙发/, key: "sofa" },
  { re: /水费|水电气|燃气|暖气/, key: "droplets" },
  { re: /维修|上门|修理/, key: "wrench" },
  { re: /旅游|旅行|度假|出行|门票/, key: "luggage" },
  { re: /游戏|电竞|网游|充值/, key: "gamepad" },
  { re: /电影|影院|演出|话剧|追剧|视频会员/, key: "film" },
  { re: /唱歌|KTV|ktv/, key: "mic" },
  { re: /音乐|专辑|歌曲/, key: "music" },
  { re: /会员|订阅|音频|听书/, key: "headphones" },
  { re: /健身|运动|瑜伽|游泳|球/, key: "dumbbell" },
  { re: /看病|门诊|挂号|医院|检查/, key: "stethoscope" },
  { re: /医疗|医药|保健|健康/, key: "health" },
  { re: /药/, key: "pill" },
  { re: /疫苗|体检|打针/, key: "syringe" },
  { re: /母婴|婴儿|宝宝|奶粉|尿布/, key: "baby" },
  { re: /宠物|猫|狗/, key: "pet" },
  { re: /学费|教育|学业|升学/, key: "graduation" },
  { re: /学习|培训|课程|考试|报名/, key: "study" },
  { re: /文具|用品/, key: "pen" },
  { re: /请客|聚餐|随礼|份子|人情/, key: "handshake" },
  { re: /红包|压岁钱|庆祝|节日/, key: "party" },
  { re: /捐赠|慈善|捐款/, key: "heart" },
  { re: /聚会|团建|派对/, key: "users" },
  { re: /工资|薪资|薪水|月薪|收入/, key: "salary" },
  { re: /奖金|奖励|提成|年终/, key: "coins" },
  { re: /理财|基金|股票|投资|收益|利息|分红/, key: "invest" },
  { re: /报销|发票|票据|退款/, key: "receipt" },
  { re: /存款|储蓄|定期/, key: "piggy" },
  { re: /信用卡|还款|贷款/, key: "creditcard" },
  { re: /银行|取现/, key: "bank" },
  { re: /转账|周转/, key: "transfer" },
  { re: /兼职|副业|外快|稿费/, key: "handcoins" },
  { re: /礼物|礼品|送礼/, key: "gift" },
  { re: /手表|饰品|珠宝|首饰/, key: "watch" },
  { re: /保险|社保|公积金/, key: "help" },
];

export function guessCategoryIcon(name: string): string {
  const n = (name || "").trim();
  if (!n) return "";
  for (const r of GUESS_RULES) if (r.re.test(n)) return r.key;
  return "";
}
