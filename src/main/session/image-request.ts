/**
 * Does a message the person wrote ask ChatGPT to create or edit an image?
 *
 * ChatGPT switches its own image tool off for a message that mentions an app, and the app
 * mentions Chat On Steroids Core in the person's messages by default (it keeps ChatGPT on this
 * computer's tools). Measured live (2026-10-05): with the mention, "create an image of …"
 * answers that no image tool is available; the same message without it draws, also as a
 * follow-up in a chat whose first message had the mention. So such a message goes out without
 * the mention (`claimBrowserInput` → `coreMention: false`), and every other message keeps it.
 *
 * A missed request leaves things as they were (no image); a false alarm only drops the mention
 * from one message. So the rules lean towards catching requests, in all the app's languages,
 * but never in a code or file context ("a Python script that draws…", "resize this PNG").
 */

/** What else is known about the message: an image attached to it, and whether the last answer made one. */
export interface ImageRequestContext { attachedImage?: boolean; afterImage?: boolean }

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** The person's prose only: no leading /commands (Skills), code, links or file paths. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^(?:\s*\/[\w.:-]+)+/u, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[’‘`]/g, "'")
    .toLowerCase();
}

const words = (list: string): string => list.trim().split(/\s*\|\s*/).join('|');
// Nouns for a picture, per language (lowercase; matched with and without accents).
const NOUN = words(`
  images? | pictures? | pics? | photos? | photographs? | illustrations? | drawings? | paintings? | artworks? | logos? | icons? |
  posters? | wallpapers? | banners? | stickers? | portraits? | cartoons? | comics? | memes? | avatars? | thumbnails? | renders? | sketch(?:es)? |
  \\p{L}*bild(?:er)? | \\p{L}*fotos? | \\p{L}*zeichnung(?:en)? | \\p{L}*gemalde | grafik(?:en)? | \\p{L}*plakat(?:e)? | \\p{L}*logos? | portrat |
  imagen(?:es)? | ilustracion(?:es)? | dibujos? | pinturas? | logotipos? | iconos? | cartel(?:es)? | fondo de pantalla | retratos? | caricaturas? | comic |
  dessins? | peintures? | icones? | affiches? | fond d'ecran | bande dessinee |
  imagem | imagens | ilustracao | ilustracoes | desenhos? | papel de parede | cartaz(?:es)? |
  изображени\\p{L}* | картин\\p{L}* | фото\\p{L}* | иллюстраци\\p{L}* | рисун\\p{L}* | логотип\\p{L}* | иконк\\p{L}* | постер\\p{L}* | плакат\\p{L}* | обои | аватар\\p{L}* |
  gorsel\\p{L}* | resim\\p{L}* | resm\\p{L}* | fotograf\\p{L}* | illustrasyon\\p{L}* | cizim\\p{L}* | ikon\\p{L}* | afis\\p{L}* | duvar kagidi | duvar kagıdı |
  hình ảnh | hình | ảnh | bức tranh | tranh | minh họa | biểu tượng | áp phích | hình nền | ảnh đại diện`);
// Verbs that ask for something new, per language (stems; lowercase, accent-free where Latin).
const CREATE = words(`
  create | generate | make | draw | paint | design | render | illustrate | sketch | produce | imagine | visuali[sz]e | give me | show me | can i (?:get|have) |
  erstell\\p{L}* | generier\\p{L}* | mach\\p{L}* | zeichne\\p{L}* | male | malen | entwirf | entwerfen | gestalte\\p{L}* | erzeug\\p{L}* |
  crea\\p{L}* | genera\\p{L}* | haz(?:me)? | dibuja\\p{L}* | pinta\\p{L}* | disena\\p{L}* |
  cree\\p{L}* | creer | genere\\p{L}* | fais | faire | dessine\\p{L}* | peins | peindre | concois |
  crie | criar | gere | gerar | faca | fazer | desenhe | desenhar | pinte | pintar |
  созда\\p{L}* | сгенерир\\p{L}* | нарису\\p{L}* | сдела\\p{L}* | нарисовать |
  olustur\\p{L}* | uret\\p{L}* | ciz | cizer | ciz\\p{L}* | yap | yapar | tasarla\\p{L}* |
  tạo | vẽ | thiết kế`);
// Wishes for a new picture: "I want a poster for …", "ich möchte ein Plakat", "quiero un cartel".
const WANT = words(`
  i want | i'd like | i would like | i'd love | i would love | would love | i need | we need | i'm looking for |
  ich mochte | ich will | ich brauche | ich hatte gern | wir brauchen | quiero | necesito | me gustaria |
  je veux | je voudrais | j'aimerais | il me faut | quero | preciso de | eu gostaria de | gostaria de |
  я хочу | мне нужн\\p{L}* | хочу | istiyorum | lazim | ihtiyacim var | tôi muốn | tôi cần`);
const ARTICLE = 'a|an|one|some|ein|eine|einen|einem|un|una|une|des|um|uma|bir|một';
const BARE_WANT = 'need|want|brauche|brauch|necesito|quiero|veux|voudrais|preciso|quero';
// Drawing and painting verbs count wherever they stand: "can you draw me …", "kannst du … zeichnen".
const DRAW = words(`
  draw | paint | sketch | zeichne | zeichnen | male | malen | dibuja\\p{L}* | dibujar\\p{L}* | pinta | pintar\\p{L}* |
  dessine\\p{L}* | dessiner | peins | peindre | desenhe | desenhar | pinte | нарису\\p{L}* | нарисовать | ciz | cizer | cizin | vẽ`);
// Changing a picture that is already there: an attached one, or the one ChatGPT just made.
const EDIT = words(`
  edit | change | turn | transform | make it | make the | restyle | recolou?r | colou?ri[sz]e | remove the background | replace the background | add |
  bearbeite\\p{L}* | ander\\p{L}* | verwandle\\p{L}* | mach es | mach das | mach daraus | mach den | mach die | mach ihn | mach sie | mache | entferne den hintergrund | fuge\\p{L}* |
  edita\\p{L}* | cambia\\p{L}* | convierte | transforma\\p{L}* | quita el fondo | anade | haz el | haz la | haz que | hazlo | hazla | ponle |
  modifie\\p{L}* | change\\p{L}* | transforme\\p{L}* | retire l'arriere-plan | ajoute\\p{L}* | rends\\p{L}* | fais le | fais la | mets |
  edite | mude | altere | transforme | remova o fundo | adicione | deixe | deixa | coloque |
  отредактиру\\p{L}* | измени\\p{L}* | преврати\\p{L}* | убери фон | добавь | сделай |
  duzenle | degistir | donustur | arka plani kaldir | arka planı kaldır | kaldir | kaldır | ekle |
  chỉnh sửa | đổi | biến | thêm | làm cho`);
// A code task, which belongs to this computer's tools whatever it draws.
const CODE = words(`
  code | script | function | component | class | html | css | svg | canvas | matplotlib | pillow | opencv | ffmpeg | imagemagick |
  program | repo | repository | commit | npm | pip | terminal | command | shell | parser | parseur | парсер\\p{L}* | коммит\\p{L}* | committe\\p{L}* |
  struct | enum | crate | endpoint | api | sdk | schema | rust | golang | kotlin | typescript | javascript |
  docker\\p{L}* | container\\p{L}* | registry | kubernetes | k8s | podman | iso image | ami | virtual machine | vm | disk image | base image |
  lazy\\p{L}* | srcset | cdn | cache\\p{L}* | og:image | meta tag | img tag | <img | sitemap | urls? | seo |
  branch(?:es)? | merge | pull request | rebase | checkout | stash |
  skript | funktion | komponente | befehl | codigo | funcion | componente | comando | fonction | composant | commande |
  код\\p{L}* | скрипт\\p{L}* | функци\\p{L}* | команд\\p{L}* | kod | betik | fonksiyon | komut\\p{L}* | mã | lệnh | hàm`);
// Text about pictures, not a picture: descriptions, captions, ideas, prompts, lists.
const ABOUT_PICTURES = words(`
  descriptions? | captions? | alt text | alt-text | ideas | prompts | list | lists | names |
  \\p{L}*beschreibung\\p{L}* | \\p{L}*unterschrift\\p{L}* | \\p{L}*ideen | \\p{L}*liste\\p{L}* | descripcion\\p{L}* | leyendas? | ideas | lista\\p{L}* |
  legendes? | idees | liste | descricao | descricoes | legendas? | ideias | описани\\p{L}* | подпис\\p{L}* | иде\\p{L}* | списо\\p{L}* |
  aciklama\\p{L}* | fikirler | liste\\p{L}* | mô tả | chú thích | ý tưởng | danh sách`);
// Files and folders: picture work on files belongs to the tools ("a thumbnail for each file in the folder").
const FILES = words(`
  file | files | folder | folders | directory | directories | datei\\p{L}* | ordner\\p{L}* | verzeichnis\\p{L}* | archivo\\p{L}* | carpeta\\p{L}* |
  fichier\\p{L}* | dossier\\p{L}* | repertoire | arquivo\\p{L}* | pasta\\p{L}* | файл\\p{L}* | папк\\p{L}* | dosya\\p{L}* | klasor\\p{L}* | tệp | thư mục`);
// "… and save it to the folder": where the picture goes, not file work.
const SAVE_VERB = /(?<![\p{L}])(?:save[sd]?|saving|stor(?:e[sd]?|ing)|download(?:s|ed|ing)?|export(?:s|ed|ing)?|speicher\p{L}*|herunterladen|exportier\p{L}*|guarda\p{L}*|descarga\p{L}*|enregistre\p{L}*|télécharge\p{L}*|salve|salvar|baixe|сохрани\p{L}*|скача\p{L}*|kaydet\p{L}*|indir|lưu|tải)(?![\p{L}])/u;
const SAVE_CLAUSE = /(?<![\p{L}])(?:save|store|put|speicher\p{L}*|lege|guarda\p{L}*|enregistre\p{L}*|salve|salvar|сохрани\p{L}*|kaydet\p{L}*|lưu)(?![\p{L}]).*$/u;
// Files and everyday work: they rule out reading a short follow-up as an image edit, not a clear request.
const TASK = words(`
  file | files | folder | directory | screenshot\\p{L}* | run | test | tests | fix | build | install | deploy | push | debug | refactor |
  datei\\p{L}* | ordner | verzeichnis | teste\\p{L}* | behebe\\p{L}* | archivo\\p{L}* | carpeta\\p{L}* | fichier\\p{L}* | dossier\\p{L}* |
  arquivo\\p{L}* | pasta\\p{L}* | файл\\p{L}* | папк\\p{L}* | dosya\\p{L}* | klasor\\p{L}* | tệp | thư mục`);
// Handling picture files: tools do that exactly, ChatGPT's image tool would redraw them.
const PROCESS = words(`
  resize | crop | compress | rotate | rename | optimi[sz]e | upload | download | delete | describe | analy[sz]e | explain | extract | ocr | read |
  convert (?:\\p{L}+ )?(?:to|into) (?:png|jpe?g|webp|gif|pdf|svg|ico|bmp|tiff?|heic) | what(?:'s| is) in | look at | view |
  grosse andern | zuschneiden | komprimier\\p{L}* | beschreib\\p{L}* | analysier\\p{L}* | erklar\\p{L}* |
  redimensiona\\p{L}* | recorta\\p{L}* | comprim\\p{L}* | describ\\p{L}* | analiz\\p{L}* |
  redimensionne\\p{L}* | recadre\\p{L}* | compresse\\p{L}* | decri\\p{L}* | analyse\\p{L}* |
  descreva | analise | comprima |
  сожми | обрежь | опиши | проанализируй |
  boyutlandir | kirp | sikistir | acikla | analiz et |
  mô tả | phân tích | nén | cắt`);

const WORD_EDGE = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';
const anyOf = (list: string): RegExp => new RegExp(`${WORD_EDGE}(?:${list})${WORD_END}`, 'u');
const aboutRe = anyOf(ABOUT_PICTURES), filesRe = anyOf(FILES);
const identifierRe = new RegExp(`${WORD_EDGE}(?:${NOUN})[-_](?!(?:style|like|realistic|real|quality|ready|perfect|based|inspired)${WORD_END})[\\p{L}\\p{N}]`, 'u');
// Tool and variable names built on a picture word ("save_image", "view_image") are technical text.
const toolNameRe = new RegExp(`[\\p{L}\\p{N}]_(?:${NOUN})${WORD_END}`, 'u');
const nounRe = anyOf(NOUN), codeRe = anyOf(CODE), taskRe = anyOf(TASK), processRe = anyOf(PROCESS), editRe = anyOf(EDIT), createRe = anyOf(CREATE);
// A request: a creating verb, then a picture noun within a few words ("create a small watercolor image").
const DEFINITE = 'the|these|those|this|that|my|our|your|its|their|die|den|das|diese|dieses|meine|unsere|las|los|estas|estos|mis|nuestras|les|ces|mes|nos|as|os|estas|estes|minhas|nossas';
const definiteRequestRe = new RegExp(`${WORD_EDGE}(?:${CREATE})${WORD_END} (?:${DEFINITE}) (?:[\\p{L}-]+ ){0,2}(?:${NOUN})${WORD_END}`, 'u');
const requestRe = new RegExp(`${WORD_EDGE}(?:${CREATE})${WORD_END}(?:[^.!?;\\n]{0,48}?)${WORD_EDGE}(?:${NOUN})${WORD_END}`, 'u');
// "An image of …", "a picture showing …": the noun names what is to be shown.
const pictureOfRe = new RegExp(`${WORD_EDGE}(?:${NOUN})${WORD_END} (?:of|showing|with|von|mit|de|del|com|du|des|с|ile) `, 'u');
// Imperative drawing on its own: "draw a cat", "zeichne einen Hund", "нарисуй кота".
const drawRe = /(?:^|[.!?\n]\s*)(?:please |bitte |por favor |s'il te plait |s'il vous plait |пожалуйста |lutfen |làm ơn )?(?:draw|paint|sketch|zeichne|male|dibuja|pinta|dessine|peins|desenhe|pinte|нарисуй|ciz|vẽ)(?![\p{L}])/u;
// Turkish puts the verb last: "bir kedi resmi oluştur", "bir köpek çiz".
const verbLastRe = new RegExp(`${WORD_EDGE}(?:${NOUN})${WORD_END}[^.!?;\\n]{0,24}?${WORD_EDGE}(?:olustur|uret|ciz|yap|tasarla)\\p{L}*(?: (?:mu|mi|mı|musun|misin|mısın|musunuz|misiniz))?\\s*$`, 'u');
const drawLastRe = /(?<![\p{L}])(?:ciz|cizer misin|cizin)\s*$/u;
// Charts and diagrams are drawn with code and data, not by ChatGPT's image tool.
const NOT_A_PICTURE = anyOf(words(`
  diagrams? | charts? | graphs? | plots? | flowcharts? | tables? | mermaid | uml | wireframes? | slides? | presentations? | spreadsheets? |
  diagramm\\p{L}* | tabelle\\p{L}* | diagrama\\p{L}* | grafico\\p{L}* | tabla\\p{L}* | diagramme\\p{L}* | graphique\\p{L}* | tableau\\p{L}* |
  grafico | tabela | диаграмм\\p{L}* | график\\p{L}* | таблиц\\p{L}* | diyagram\\p{L}* | grafi\\p{L}* | tablo\\p{L}* | biểu đồ | sơ đồ | bảng`));
const QUESTION = /^(?:what|why|how|which|where|when|did you|have you|was|warum|wieso|wie|welche\p{L}*|hast du|que|que |qué|por que|por qué|como|cómo|cual|cuál|pourquoi|comment|quel\p{L}*|qu'|o que|qual|что|почему|как|какой|зачем|ne |neden|nasil|nasıl|hangi|gì|tại sao|như thế nào)(?![\p{L}])/u;
const wantRe = new RegExp(`${WORD_EDGE}(?:${WANT})${WORD_END}(?:[^.!?;\\n]{0,24}?${WORD_EDGE}(?:${ARTICLE})${WORD_END})?[^.!?;\\n]{0,24}?${WORD_EDGE}(?:${NOUN})${WORD_END}`, 'u');
const bareWantRe = new RegExp(`${WORD_EDGE}(?:${BARE_WANT}) (?:${ARTICLE}) (?:[\\p{L}\\p{N}x-]+ ){0,3}(?:${NOUN})${WORD_END}`, 'u');
// German questions put the infinitive last: "kannst du ein Logo für meinen Podcast machen?".
const germanLastRe = new RegExp(`${WORD_EDGE}(?:${NOUN})${WORD_END}[^.!?;\\n]{0,48}?${WORD_EDGE}(?:machen|erstellen|zeichnen|malen|generieren|entwerfen|gestalten|erzeugen)\\s*$`, 'u');
const drawAnywhereRe = new RegExp(`${WORD_EDGE}(?:${DRAW})${WORD_END}`, 'u');
const notARequest = /(?<![\p{L}])(?:make sure|make it work|draw (?:a |the )?conclusions?|draw attention|stelle sicher|asegurate|assure-toi|certifique-se|убедись|emin ol|đảm bảo)(?![\p{L}])/u;

// Chinese, Japanese and Korean write without spaces: a picture word and a making word in one sentence.
const CJK_NOUN = /图片|图像|插画|插图|照片|画像|海报|壁纸|标志|图标|头像|圖片|圖像|插畫|海報|桌布|標誌|圖示|頭像|イラスト|ロゴ|アイコン|ポスター|壁紙|写真|絵|이미지|그림|사진|일러스트|로고|아이콘|포스터|배경화면|프로필 사진/u;
const CJK_DRAW = /帮我画|画一只|画一个|画一幅|画一张|请画|畫一隻|畫一個|畫一幅|幫我畫|請畫|を描いて|を描け|그려줘|그려 줘|그려주세요/u;
const CJK_NOT_A_PICTURE = /图表|流程图|架构图|表格|圖表|流程圖|架構圖|図表|フローチャート|グラフ|차트|그래프|다이어그램|표를/u;
const CJK_CREATE = /デザインして|デザイン|を作って|作って|生成|画一|画个|画张|画幅|画出|帮我画|创建|制作|设计|做一|做个|繪製|畫一|畫個|畫張|建立|製作|設計|作って|作成|生成して|描いて|かいて|書いて|만들어|생성|그려|제작|디자인/u;
const CJK_CODE = /代码|脚本|(?<!应用|小)程序|函数|组件|組件|代碼|腳本|(?<!應用)程式|函式|コード|スクリプト|プログラム|関数|코드|스크립트|프로그램|함수|解析器|パーサー|파서/u;
const CJK_FILES = /文件夹|文件|資料夾|檔案|フォルダ|ファイル|폴더|파일|重命名|重新命名|名前を変え|이름을/u;
const CJK_ABOUT = /说明|說明|描述|标题|標題|想法|点子|キャプション|アイデア|説明文|캡션|아이디어|설명/u;
const CJK_TASK = /文件|檔案|ファイル|파일|截图|截圖|スクリーンショット|스크린샷|测试|測試|テスト|테스트|提交|コミット|커밋|解析器|パーサー|파서/u;
const CJK_PROCESS = /压缩|裁剪|调整大小|描述|分析|壓縮|裁切|調整大小|描述|圧縮|トリミング|リサイズ|説明|分析|압축|자르|크기 조정|설명|분석/u;
const CJK_EDIT = /加上|加一|添加|加个|加個|加入|换成|換成|改为|改為|追加して|加えて|つけて|추가해|넣어|修改|改成|变成|改為|變成|编辑|編輯|去掉背景|变得|編集|変えて|背景を消|にして|수정|바꿔|편집|배경 제거|로 만들어/u;

function sentences(text: string): string[] {
  // A "." ends a sentence only before a space or the end, never inside a file name or a number.
  return text.split(/[.!?;]+(?=\s|$)|[\n。！？；]+/u).map(part => part.trim()).filter(Boolean);
}

export function asksForImage(text: string, context: ImageRequestContext = {}): boolean {
  const raw = prose(text).trim();
  if (!raw) return false;
  const forms = [raw, fold(raw)];
  const any = (re: RegExp): boolean => forms.some(form => re.test(form));
  if (any(codeRe) || any(identifierRe) || any(toolNameRe) || CJK_CODE.test(raw)) return false;
  for (const sentence of sentences(raw)) {
    const variants = [sentence, fold(sentence)];
    const has = (re: RegExp): boolean => variants.some(form => re.test(form));
    if (has(notARequest)) continue;
    const processing = has(processRe) || CJK_PROCESS.test(sentence) || has(aboutRe) || CJK_ABOUT.test(sentence) || CJK_FILES.test(sentence.replace(/(?:保存|儲存|存到|保存して|저장).*$/u, '')) ||
      variants.some(form => filesRe.test(form.replace(SAVE_CLAUSE, '')));
    // "Save the image you just generated as boat.png": saving comes first, so the picture exists and
    // this is file work. "Create a picture …, then save it as …" creates first and still counts.
    const firstAt = (re: RegExp): number => Math.min(...variants.map(form => form.search(re)).filter(at => at >= 0), Infinity);
    const saveAt = firstAt(SAVE_VERB);
    if (saveAt < Infinity && saveAt < Math.min(firstAt(createRe), firstAt(drawRe), firstAt(editRe))) continue;
    const picture = has(nounRe) || CJK_NOUN.test(sentence);
    // "Draw a diagram": a chart or diagram, unless a picture is named too, and named first
    // ("a table of the image sizes" makes a table; "an image of a chart" makes an image).
    const notPictureAt = Math.min(...variants.map(form => form.search(NOT_A_PICTURE)).filter(at => at >= 0), Infinity);
    const pictureAt = Math.min(...variants.map(form => form.search(nounRe)).filter(at => at >= 0), Infinity);
    if ((!picture && (notPictureAt < Infinity || CJK_NOT_A_PICTURE.test(sentence))) || notPictureAt < pictureAt) continue;
    // "Make the images lazy-load": pictures that exist, unless one was just made or attached.
    const existing = has(definiteRequestRe) && !context.afterImage && !context.attachedImage;
    const creates = (has(requestRe) && !existing) || has(pictureOfRe) || has(drawRe) || has(verbLastRe) || has(drawLastRe) ||
      has(wantRe) || has(bareWantRe) || has(germanLastRe) || has(drawAnywhereRe) ||
      CJK_DRAW.test(sentence) || (CJK_NOUN.test(sentence) && CJK_CREATE.test(sentence));
    if (creates && !processing) return true;
    // A picture that is already there, attached or just made, being changed: "make it brighter".
    // Only short messages without files or everyday work count: "now run the tests" is not an edit.
    if (processing || has(taskRe) || CJK_TASK.test(sentence) || variants.some(form => QUESTION.test(form))) continue;
    const editing = has(editRe) || CJK_EDIT.test(sentence);
    const followUp = context.afterImage && raw.length <= 300;
    if (editing && (context.attachedImage || followUp)) return true;
    if (followUp && (has(nounRe) || CJK_NOUN.test(sentence)) && has(createRe)) return true;
  }
  return false;
}
