/**
 * categoryIcons.ts — 记账分类图标库
 *
 * 图标优先用内置的 Microsoft Fluent Emoji Flat 彩色 SVG（见 categoryArt.ts，
 * 离线、无网络请求、Android/PC 显示一致）；万一某个 key 没有内置图，
 * 再退回 Obsidian 内置 Lucide（候选名依次试，取第一个真正渲染出 svg 的），
 * 最后退回分类名首字，不会留空白格子。
 *
 * 分类的 icon 字段存这里的 key；空 = 按分类名自动匹配（guessCategoryIcon）。
 */
import { setIcon } from "obsidian";
import { CATEGORY_ART } from "./categoryArt";

export interface CategoryIconDef {
  key: string;
  label: string;
  /** 内置彩色图缺失时的 Lucide 候选名（新版改名时旧名兜底） */
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
      it("tea", "茶叶茶具", "coffee"),
      it("bubbletea", "奶茶饮品", "cup-soda", "coffee"),
      it("beer", "酒水酒吧", "beer", "wine"),
      it("wine", "红酒洋酒", "wine", "beer"),
      it("cocktail", "鸡尾酒", "martini", "wine"),
      it("cake", "甜品蛋糕", "cake", "cake-slice"),
      it("cupcake", "纸杯蛋糕", "cake", "cake-slice"),
      it("birthday", "生日蛋糕", "cake", "gift"),
      it("pizza", "披萨", "pizza"),
      it("sandwich", "三明治", "sandwich"),
      it("hamburger", "汉堡快餐", "sandwich", "pizza"),
      it("fries", "薯条", "french-fries", "utensils"),
      it("hotdog", "热狗", "sandwich"),
      it("rice", "米饭", "utensils", "cooking-pot"),
      it("noodle", "面食", "utensils", "soup"),
      it("dumpling", "饺子", "utensils", "cooking-pot"),
      it("sushi", "寿司", "fish", "utensils"),
      it("hotpot", "火锅", "soup", "cooking-pot"),
      it("soup", "汤煲", "soup", "cooking-pot"),
      it("bento", "便当", "utensils"),
      it("cookie", "零食饼干", "cookie", "candy"),
      it("candy", "糖果甜点", "candy", "lollipop"),
      it("icecream", "冰淇淋", "ice-cream-cone", "ice-cream"),
      it("fish", "海鲜水产", "fish", "shrimp"),
      it("shrimp", "虾蟹", "shrimp", "fish"),
      it("crab", "螃蟹", "shrimp", "fish"),
      it("meat", "肉类", "beef", "meat"),
      it("apple", "水果生鲜", "apple", "cherry", "banana"),
      it("watermelon", "西瓜", "apple", "cherry"),
      it("grapes", "葡萄", "grape", "apple"),
      it("strawberry", "草莓", "cherry", "apple"),
      it("vegetable", "蔬菜", "carrot", "salad"),
      it("egg", "蛋类早餐", "egg", "egg-fried"),
      it("bread", "面包烘焙", "croissant", "bread"),
      it("popcorn", "爆米花", "popcorn"),
    ],
  },
  {
    title: "交通出行",
    items: [
      it("car", "汽车驾车", "car", "car-front"),
      it("taxi", "打车出租", "car-taxi-front", "car"),
      it("bus", "公交", "bus", "bus-front"),
      it("minibus", "中巴小巴", "bus", "bus-front"),
      it("train", "火车高铁", "train-front", "train"),
      it("metro", "地铁", "train-front", "train"),
      it("tram", "有轨电车", "tram-front", "train-front"),
      it("plane", "飞机机票", "plane", "plane-takeoff"),
      it("helicopter", "直升机", "plane", "navigation"),
      it("ship", "轮船渡轮", "ship", "sailboat"),
      it("boat", "快艇", "sailboat", "ship"),
      it("truck", "货运搬家", "truck"),
      it("pickup", "皮卡", "truck", "car"),
      it("fuel", "加油油费", "fuel", "gas-pump"),
      it("bike", "骑行单车", "bike"),
      it("parking", "停车费", "circle-parking", "square-parking", "car"),
      it("map", "导航地图", "map", "navigation", "compass"),
      it("luggage", "旅行行李", "luggage", "suitcase"),
      it("compass", "户外指南", "compass", "map"),
      it("tent", "露营", "tent", "tree-pine"),
      it("beach", "度假", "palmtree", "sun"),
      it("rocket", "火箭", "rocket"),
    ],
  },
  {
    title: "购物消费",
    items: [
      it("cart", "购物日用", "shopping-cart", "shopping-basket"),
      it("shopping", "网购电商", "shopping-bag", "store"),
      it("shirt", "服饰", "shirt"),
      it("dress", "连衣裙", "shirt"),
      it("jeans", "裤装", "shirt"),
      it("shoes", "鞋靴", "footprints", "shirt"),
      it("handbag", "包包", "shopping-bag", "briefcase"),
      it("gem", "珠宝饰品", "gem", "diamond"),
      it("ring", "戒指", "gem", "circle"),
      it("watch", "手表配饰", "watch"),
      it("glasses", "眼镜", "glasses"),
      it("cosmetics", "美妆", "sparkles", "brush"),
      it("skincare", "护肤", "droplets", "sparkles"),
      it("package", "快递物流", "package", "box"),
      it("store", "商超便利", "store", "building"),
      it("department", "百货商场", "store", "building"),
      it("tag", "优惠折扣", "tag", "tags", "percent"),
      it("gift", "礼物礼品", "gift"),
      it("ticket", "票务演出", "ticket"),
      it("balloon", "气球派对", "party-popper", "gift"),
    ],
  },
  {
    title: "居家生活",
    items: [
      it("home", "住房房租", "house", "home"),
      it("rent", "租房押金", "key", "house"),
      it("bed", "床品住宿", "bed", "bed-double"),
      it("bath", "洗浴清洁", "bath", "shower-head"),
      it("sofa", "家具", "sofa", "armchair"),
      it("chair", "椅子", "armchair", "sofa"),
      it("lamp", "灯具照明", "lamp", "lamp-desk"),
      it("tv", "电视影音", "tv", "monitor"),
      it("fridge", "冰箱", "refrigerator", "ice-cream"),
      it("washing", "洗衣机", "washing-machine"),
      it("broom", "清洁打扫", "brush-cleaning", "sparkles"),
      it("soap", "洗护日用", "soap-dispenser-droplet", "droplets"),
      it("toothbrush", "口腔护理", "brush", "sparkles"),
      it("plug", "电费", "plug", "zap"),
      it("droplets", "水费", "droplets", "flame"),
      it("gas", "燃气暖气", "flame", "zap"),
      it("wrench", "维修上门", "wrench", "hammer"),
      it("toolbox", "工具", "wrench", "hammer"),
      it("hammer", "装修", "hammer", "wrench"),
      it("door", "门锁", "door-closed", "lock"),
      it("window", "窗户", "app-window", "square"),
      it("mirror", "镜子", "circle", "rectangle-horizontal"),
      it("umbrella", "雨具", "umbrella"),
      it("plant", "绿植", "sprout", "flower"),
      it("wifi", "网费宽带", "wifi", "router"),
      it("phone", "手机数码", "smartphone", "tablet"),
      it("laptop", "电脑办公", "laptop", "monitor"),
      it("printer", "打印", "printer"),
      it("battery", "电池", "battery", "battery-charging"),
      it("lightbulb", "照明", "lightbulb", "zap"),
    ],
  },
  {
    title: "文化娱乐",
    items: [
      it("gamepad", "游戏电竞", "gamepad-2", "gamepad"),
      it("joystick", "街机", "gamepad-2", "gamepad"),
      it("dice", "桌游", "dice-5", "dices"),
      it("film", "电影", "film", "clapperboard"),
      it("camera", "摄影拍照", "camera"),
      it("music", "音乐歌曲", "music", "audio-lines"),
      it("guitar", "乐器", "guitar", "music"),
      it("drum", "架子鼓", "drum", "music"),
      it("mic", "唱歌KTV", "mic", "mic-vocal"),
      it("headphones", "耳机音频", "headphones", "headset"),
      it("book", "图书阅读", "book", "book-open"),
      it("news", "报刊杂志", "newspaper"),
      it("palette", "绘画手作", "palette", "brush"),
      it("brush", "手作", "brush", "palette"),
      it("puzzle", "拼图", "puzzle", "gamepad-2"),
      it("trophy", "比赛竞技", "trophy", "medal"),
      it("medal", "奖牌", "medal", "trophy"),
      it("party", "庆祝聚会", "party-popper", "sparkles"),
      it("teddy", "玩偶", "teddy-bear", "gift"),
      it("kite", "风筝", "wind", "sparkles"),
      it("dumbbell", "健身运动", "dumbbell"),
    ],
  },
  {
    title: "医疗健康",
    items: [
      it("health", "医疗健康", "heart-pulse", "heart"),
      it("stethoscope", "看病门诊", "stethoscope"),
      it("pill", "药品保健", "pill"),
      it("hospital", "医院住院", "hospital", "cross"),
      it("syringe", "疫苗体检", "syringe"),
      it("bandage", "外伤处理", "bandage", "cross"),
      it("thermometer", "发烧体温", "thermometer"),
      it("crutch", "康复", "accessibility", "heart-pulse"),
      it("dna", "基因检测", "dna", "microscope"),
      it("microscope", "化验检查", "microscope"),
      it("baby", "母婴用品", "baby"),
      it("pet", "宠物", "dog", "cat", "pawprint"),
      it("cat", "猫咪", "cat", "dog"),
      it("paw", "宠物周边", "pawprint", "dog"),
    ],
  },
  {
    title: "教育学习",
    items: [
      it("graduation", "学业教育", "graduation-cap"),
      it("school", "学校", "school", "graduation-cap"),
      it("study", "学习培训", "book-open", "notebook-pen"),
      it("notebook", "笔记本", "notebook-pen", "book"),
      it("pen", "文具用品", "pencil", "pen"),
      it("calculator", "计算", "calculator"),
      it("backpack", "书包学具", "backpack"),
      it("bookmark", "书签", "bookmark"),
      it("scroll", "证书文凭", "scroll-text", "award"),
      it("geography", "地理", "globe-2", "earth"),
      it("clipboard", "报名清单", "clipboard-list", "clipboard"),
      it("memo", "备忘记录", "notebook-pen", "sticky-note"),
    ],
  },
  {
    title: "人情社交",
    items: [
      it("handshake", "请客随礼", "heart-handshake", "handshake"),
      it("redpacket", "红包", "mail", "gift"),
      it("bouquet", "鲜花", "flower", "flower-2"),
      it("heart", "慈善捐赠", "heart"),
      it("users", "聚餐聚会", "users", "user"),
      it("folded", "人情礼节", "hand-heart", "handshake"),
      it("ribbon", "节日丝带", "ribbon", "gift"),
      it("crown", "婚礼庆典", "crown", "gem"),
    ],
  },
  {
    title: "收入理财",
    items: [
      it("salary", "工资薪资", "briefcase"),
      it("banknote", "现金收入", "banknote"),
      it("yuan", "人民币收入", "banknote", "coins"),
      it("coins", "零钱积分", "coins"),
      it("piggy", "存款储蓄", "piggy-bank"),
      it("creditcard", "信用卡", "credit-card"),
      it("wallet", "钱包余额", "wallet"),
      it("bank", "银行利息", "landmark", "building-2"),
      it("atm", "取现", "landmark", "banknote"),
      it("receipt", "报销退款", "receipt", "receipt-text"),
      it("invest", "投资理财", "trending-up", "chart-line", "line-chart"),
      it("loss", "亏损", "trending-down", "chart-line"),
      it("handcoins", "收款进账", "hand-coins", "hand-heart"),
      it("transfer", "转账还款", "arrow-left-right", "repeat"),
      it("percent", "税费手续费", "percent"),
      it("scale", "对账", "scale", "git-compare"),
      it("ledger", "账本", "book-open", "notebook"),
    ],
  },
  {
    title: "通用",
    items: [
      it("star", "常用", "star"),
      it("sparkles", "其他杂项", "sparkles"),
      it("more", "更多", "ellipsis", "plus"),
      it("help", "待定", "circle-help", "help-circle"),
      it("building", "公司事务", "building", "building-2"),
      it("globe", "网络服务", "globe"),
      it("mail", "邮件", "mail", "envelope"),
      it("calendar", "日历", "calendar"),
      it("reminder", "提醒", "bell", "alarm-clock"),
      it("fire", "热门", "flame", "fire"),
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

/** 把 SVG 标记解析成可插入当前文档的元素（不用 innerHTML；弹窗窗口也能用） */
function parseArt(doc: Document, markup: string): SVGElement | null {
  try {
    const Win = doc.defaultView;
    const Parser = Win?.DOMParser ?? DOMParser;
    const parsed = new Parser().parseFromString(markup, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") return null;
    return doc.importNode(root, true) as unknown as SVGElement;
  } catch {
    return null;
  }
}

/** 画分类图标：图标库 SVG / emoji / data URL，缺图退 Lucide，最后退回分类名首字 */
export function renderCategoryIcon(el: HTMLElement, key: string, fallbackText: string): void {
  const raw = (key || "").trim();
  const def = raw ? BY_KEY.get(raw) : undefined;
  el.empty();
  el.removeClass("db-icon-art", "db-icon-emoji", "db-icon-img-wrap");

  const art = def ? CATEGORY_ART[def.key] : undefined;
  if (art) {
    const svg = parseArt(el.ownerDocument, art);
    if (svg) {
      el.addClass("db-icon-art");
      el.appendChild(svg);
      return;
    }
  }

  // 本地图片：配置里存 data URL，离线可用
  if (/^data:image\//i.test(raw)) {
    el.addClass("db-icon-img-wrap");
    el.createEl("img", { cls: "db-icon-img", attr: { src: raw, alt: "" } });
    return;
  }

  // 自定义 emoji / 文字：不是图标库 key 就当字面量显示
  if (raw && !/^[a-z0-9-]+$/.test(raw)) {
    el.addClass("db-icon-emoji");
    el.setText(raw);
    return;
  }

  if (def) {
    setAnyIcon(el, def.lucide);
    if (el.querySelector("svg")) return;
    el.empty();
  }

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
  // 餐饮
  { re: /早餐|早饭|早点/, key: "egg" },
  { re: /午餐|午饭|中饭/, key: "sandwich" },
  { re: /晚餐|晚饭|夜宵|宵夜/, key: "soup" },
  { re: /咖啡/, key: "coffee" },
  { re: /奶茶/, key: "bubbletea" },
  { re: /茶|饮品|饮料|豆浆/, key: "tea" },
  { re: /红酒|洋酒|葡萄酒/, key: "wine" },
  { re: /鸡尾酒/, key: "cocktail" },
  { re: /啤酒|酒水|酒吧|白酒|酒/, key: "beer" },
  { re: /生日/, key: "birthday" },
  { re: /蛋糕|甜品|甜点|烘焙|点心/, key: "cake" },
  { re: /披萨|比萨/, key: "pizza" },
  { re: /三明治/, key: "sandwich" },
  { re: /汉堡/, key: "hamburger" },
  { re: /薯条/, key: "fries" },
  { re: /热狗/, key: "hotdog" },
  { re: /米饭|米线/, key: "rice" },
  { re: /面包/, key: "bread" },
  { re: /面|粉|拉面|意面/, key: "noodle" },
  { re: /饺子|包子|馄饨/, key: "dumpling" },
  { re: /寿司|日料/, key: "sushi" },
  { re: /火锅/, key: "hotpot" },
  { re: /汤|煲|粥/, key: "soup" },
  { re: /便当|盒饭|外卖/, key: "bento" },
  { re: /零食|小食|饼干|坚果/, key: "cookie" },
  { re: /糖/, key: "candy" },
  { re: /冰淇淋|雪糕/, key: "icecream" },
  { re: /海鲜|水产|鱼/, key: "fish" },
  { re: /虾/, key: "shrimp" },
  { re: /蟹/, key: "crab" },
  { re: /肉|牛排|烧烤/, key: "meat" },
  { re: /西瓜/, key: "watermelon" },
  { re: /葡萄/, key: "grapes" },
  { re: /草莓/, key: "strawberry" },
  { re: /水果|生鲜|苹果/, key: "apple" },
  { re: /蔬菜|菜市场|买菜/, key: "vegetable" },
  { re: /蛋/, key: "egg" },
  { re: /爆米花/, key: "popcorn" },
  { re: /餐|食|饭|吃|餐厅|食堂|三餐|下午茶/, key: "utensils" },
  // 交通
  { re: /打车|出租|网约车|专车/, key: "taxi" },
  { re: /地铁/, key: "metro" },
  { re: /公交|通勤|交通/, key: "bus" },
  { re: /火车|高铁|动车|城铁/, key: "train" },
  { re: /电车|有轨/, key: "tram" },
  { re: /飞机|机票|航空/, key: "plane" },
  { re: /直升机/, key: "helicopter" },
  { re: /船|轮渡|邮轮/, key: "ship" },
  { re: /快艇|游艇/, key: "boat" },
  { re: /加油|油费|油耗/, key: "fuel" },
  { re: /停车|车位/, key: "parking" },
  { re: /单车|骑行|共享/, key: "bike" },
  { re: /导航|地图/, key: "map" },
  { re: /露营|帐篷/, key: "tent" },
  { re: /海边|沙滩|度假/, key: "beach" },
  { re: /快递|包裹|物流|邮政/, key: "package" },
  // 购物
  { re: /商场|百货/, key: "department" },
  { re: /购物|网购|电商|日用/, key: "shopping" },
  { re: /超市|便利|商超/, key: "store" },
  { re: /衣服|服饰|穿搭|衣/, key: "shirt" },
  { re: /裙/, key: "dress" },
  { re: /裤/, key: "jeans" },
  { re: /鞋|靴/, key: "shoes" },
  { re: /箱包|包包/, key: "handbag" },
  { re: /美妆|化妆|美容|理发|美发/, key: "cosmetics" },
  { re: /护肤|洗面奶|面膜/, key: "skincare" },
  // 居家
  { re: /话费|手机|通讯|宽带|网费|流量/, key: "phone" },
  { re: /房租|房贷|住房|物业|居住|家装|家居|装修/, key: "home" },
  { re: /租房|押金/, key: "rent" },
  { re: /住宿|酒店|民宿|宾馆/, key: "bed" },
  { re: /家电|电视|冰箱|洗衣机/, key: "tv" },
  { re: /家具|沙发/, key: "sofa" },
  { re: /水费|水电气|燃气|暖气/, key: "droplets" },
  { re: /电费|充电|电瓶/, key: "plug" },
  { re: /维修|上门|修理/, key: "wrench" },
  { re: /工具|五金/, key: "toolbox" },
  { re: /门锁|钥匙/, key: "door" },
  { re: /窗/, key: "window" },
  { re: /雨伞|雨具/, key: "umbrella" },
  // 旅行 / 娱乐 / 教育 / 医疗
  { re: /旅游|旅行|出行|门票/, key: "luggage" },
  { re: /游戏|电竞|网游|充值/, key: "gamepad" },
  { re: /街机|电玩/, key: "joystick" },
  { re: /桌游|棋牌/, key: "dice" },
  { re: /电影|影院|演出|话剧|追剧|视频会员/, key: "film" },
  { re: /唱歌|KTV|ktv/, key: "mic" },
  { re: /音乐|专辑|歌曲/, key: "music" },
  { re: /乐器|吉他|钢琴/, key: "guitar" },
  { re: /会员|订阅|音频|听书/, key: "headphones" },
  { re: /健身|运动|瑜伽|游泳|球/, key: "dumbbell" },
  { re: /图书|阅读|看书/, key: "book" },
  { re: /报刊|杂志|报纸/, key: "news" },
  { re: /画画|绘画|美术/, key: "palette" },
  { re: /手作|手工|陶艺/, key: "brush" },
  { re: /拼图/, key: "puzzle" },
  { re: /比赛|竞技/, key: "trophy" },
  { re: /奖牌|奖杯/, key: "medal" },
  { re: /玩偶|娃娃/, key: "teddy" },
  { re: /风筝/, key: "kite" },
  { re: /看病|门诊|挂号|医院|检查/, key: "stethoscope" },
  { re: /医疗|医药|保健|健康/, key: "health" },
  { re: /药/, key: "pill" },
  { re: /疫苗|体检|打针/, key: "syringe" },
  { re: /外伤|创可贴|包扎/, key: "bandage" },
  { re: /发烧|体温/, key: "thermometer" },
  { re: /康复|轮椅|拐杖/, key: "crutch" },
  { re: /基因|化验|检验/, key: "dna" },
  { re: /母婴|婴儿|宝宝|奶粉|尿布/, key: "baby" },
  { re: /宠物|猫|狗/, key: "pet" },
  { re: /学费|教育|学业|升学/, key: "graduation" },
  { re: /学校|幼儿园/, key: "school" },
  { re: /学习|培训|课程|考试|报名/, key: "study" },
  { re: /文具|用品/, key: "pen" },
  { re: /证书|文凭/, key: "scroll" },
  // 人情 / 理财
  { re: /鲜花|花束|买花/, key: "bouquet" },
  { re: /请客|聚餐|随礼|份子|人情/, key: "handshake" },
  { re: /红包|压岁钱|庆祝|节日/, key: "redpacket" },
  { re: /捐赠|慈善|捐款/, key: "heart" },
  { re: /聚会|团建|派对/, key: "users" },
  { re: /婚礼|婚庆/, key: "crown" },
  { re: /工资|薪资|薪水|月薪|收入/, key: "salary" },
  { re: /奖金|奖励|提成|年终/, key: "coins" },
  { re: /亏损|赔钱/, key: "loss" },
  { re: /理财|基金|股票|投资|收益|利息|分红/, key: "invest" },
  { re: /报销|发票|票据|退款/, key: "receipt" },
  { re: /存款|储蓄|定期/, key: "piggy" },
  { re: /信用卡|还款|贷款/, key: "creditcard" },
  { re: /银行|取现|ATM|atm/, key: "bank" },
  { re: /转账|周转/, key: "transfer" },
  { re: /兼职|副业|外快|稿费/, key: "handcoins" },
  { re: /礼物|礼品|送礼/, key: "gift" },
  { re: /手表|饰品|珠宝|首饰/, key: "watch" },
  { re: /保险|社保|公积金/, key: "help" },
  { re: /日历/, key: "calendar" },
  { re: /提醒|闹钟/, key: "reminder" },
  { re: /邮件|邮箱/, key: "mail" },
];

export function guessCategoryIcon(name: string): string {
  const n = (name || "").trim();
  if (!n) return "";
  for (const r of GUESS_RULES) if (r.re.test(n)) return r.key;
  return "";
}
