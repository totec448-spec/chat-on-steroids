import { describe, expect, it } from 'vitest';
import { asksForImage } from '../src/main/session/image-request.js';

/**
 * Everyday phrasings in each language the app speaks. `yes` asks ChatGPT for a new picture;
 * `no` looks similar but is code, file work, text about pictures or a question; `edit` changes an
 * attached picture; `followUp` changes the picture ChatGPT just made; `work` is a follow-up that
 * is not about the picture.
 */
const corpus: Record<string, { yes: string[]; no: string[]; edit: string[]; followUp: string[]; work: string[] }> = {
  en: {
    yes: ['Create an image of a fox in a misty forest', 'Can you draw me a dragon?', 'Make a logo for "Bean There" coffee', 'I want a poster for a jazz night',
      'Generate a desktop wallpaper with a calm lake', 'Design an app icon for a to-do app', 'Paint a portrait of an old sailor', 'Show me a picture of a futuristic city'],
    no: ['Write a function that resizes images', 'Rename all images in the folder to lowercase', 'Describe what you see in this image', 'Plot a chart of CPU usage',
      'Write captions for these photos', 'Give me ideas for a logo', 'Make sure the logo is centered in the header', 'Check why the image fails to load in the browser'],
    edit: ['Turn this photo into a pencil sketch', 'Make it look like a Van Gogh painting', 'Remove the background', 'Add sunglasses to the dog'],
    followUp: ['make it more colorful', 'Change the sky to sunset', 'add a small boat on the lake', 'make the dragon green'],
    work: ['now run the tests', 'commit that please', 'what did you change in the parser?', 'fix the lint errors']
  },
  de: {
    yes: ['Erstelle ein Bild von einem Fuchs im Nebelwald', 'Kannst du mir einen Drachen zeichnen?', 'Mach ein Logo für das Café „Bohnenzeit“', 'Ich möchte ein Plakat für einen Jazzabend',
      'Generiere ein Hintergrundbild mit einem ruhigen See', 'Entwirf ein App-Icon für eine Aufgaben-App', 'Male ein Porträt eines alten Seemanns', 'Erstelle ein Profilbild mit einem Fuchs'],
    no: ['Schreibe eine Funktion, die Bilder verkleinert', 'Benenne alle Bilder im Ordner um', 'Beschreibe, was du auf diesem Bild siehst', 'Erstelle ein Diagramm der CPU-Auslastung',
      'Schreibe Bildunterschriften für diese Fotos', 'Gib mir Ideen für ein Logo', 'Stelle sicher, dass das Logo im Header zentriert ist', 'Prüfe, warum das Bild im Browser nicht lädt'],
    edit: ['Verwandle dieses Foto in eine Bleistiftzeichnung', 'Mach es wie ein Gemälde von Van Gogh', 'Entferne den Hintergrund', 'Füge dem Hund eine Sonnenbrille hinzu'],
    followUp: ['mach es bunter', 'Ändere den Himmel zu Sonnenuntergang', 'füge ein kleines Boot auf dem See hinzu', 'mach den Drachen grün'],
    work: ['jetzt die Tests ausführen', 'committe das bitte', 'was hast du im Parser geändert?', 'behebe die Lint-Fehler']
  },
  es: {
    yes: ['Crea una imagen de un zorro en un bosque con niebla', '¿Puedes dibujarme un dragón?', 'Haz un logo para la cafetería Grano', 'Quiero un cartel para una noche de jazz',
      'Genera un fondo de pantalla con un lago tranquilo', 'Diseña un icono para una app de tareas', 'Pinta un retrato de un viejo marinero', 'Hazme una ilustración de una ciudad futurista'],
    no: ['Escribe una función que redimensione imágenes', 'Renombra todas las imágenes de la carpeta', 'Describe lo que ves en esta imagen', 'Haz un gráfico del uso de CPU',
      'Escribe leyendas para estas fotos', 'Dame ideas para un logo', 'Asegúrate de que el logo esté centrado', 'Revisa por qué la imagen no carga en el navegador'],
    edit: ['Convierte esta foto en un dibujo a lápiz', 'Quita el fondo', 'Cambia el color del coche a rojo', 'Añade gafas de sol al perro'],
    followUp: ['cambia el cielo a un atardecer', 'añade un barco pequeño en el lago', 'cámbialo a verde', 'haz el dragón verde'],
    work: ['ahora ejecuta los tests', 'haz commit por favor', '¿qué cambiaste en el parser?', 'arregla los errores de lint']
  },
  fr: {
    yes: ['Crée une image d’un renard dans une forêt brumeuse', 'Peux-tu me dessiner un dragon ?', 'Fais un logo pour le café Grain', 'Je veux une affiche pour une soirée jazz',
      'Génère un fond d’écran avec un lac calme', 'Conçois une icône pour une application de tâches', 'Peins le portrait d’un vieux marin', 'Crée une illustration d’une ville futuriste'],
    no: ['Écris une fonction qui redimensionne des images', 'Renomme toutes les images du dossier', 'Décris ce que tu vois sur cette image', 'Fais un graphique de l’utilisation du CPU',
      'Écris des légendes pour ces photos', 'Donne-moi des idées de logo', 'Assure-toi que le logo est centré', 'Vérifie pourquoi l’image ne se charge pas'],
    edit: ['Transforme cette photo en dessin au crayon', 'Retire l’arrière-plan', 'Change la couleur de la voiture en rouge', 'Ajoute des lunettes de soleil au chien'],
    followUp: ['change le ciel en coucher de soleil', 'ajoute un petit bateau sur le lac', 'modifie le dragon en vert', 'transforme-le en aquarelle'],
    work: ['maintenant lance les tests', 'fais un commit s’il te plaît', 'qu’as-tu changé dans le parseur ?', 'corrige les erreurs de lint']
  },
  'pt-BR': {
    yes: ['Crie uma imagem de uma raposa numa floresta com neblina', 'Você pode desenhar um dragão?', 'Faça um logo para a cafeteria Grão', 'Quero um cartaz para uma noite de jazz',
      'Gere um papel de parede com um lago calmo', 'Crie um ícone para um app de tarefas', 'Pinte um retrato de um velho marinheiro', 'Desenhe uma cidade futurista'],
    no: ['Escreva uma função que redimensione imagens', 'Renomeie todas as imagens da pasta', 'Descreva o que você vê nesta imagem', 'Faça um gráfico do uso de CPU',
      'Escreva legendas para estas fotos', 'Me dê ideias para um logo', 'Certifique-se de que o logo está centralizado', 'Verifique por que a imagem não carrega'],
    edit: ['Transforme esta foto em um desenho a lápis', 'Remova o fundo', 'Mude a cor do carro para vermelho', 'Adicione óculos de sol ao cachorro'],
    followUp: ['mude o céu para pôr do sol', 'adicione um barquinho no lago', 'altere o dragão para verde', 'transforme em aquarela'],
    work: ['agora rode os testes', 'faça o commit por favor', 'o que você mudou no parser?', 'corrija os erros de lint']
  },
  ru: {
    yes: ['Создай изображение лисы в туманном лесу', 'Нарисуй мне дракона', 'Сделай логотип для кофейни «Зерно»', 'Сгенерируй обои с тихим озером',
      'Создай иконку для приложения задач', 'Нарисуй портрет старого моряка', 'Создай постер для джазового вечера', 'Сгенерируй картинку футуристического города'],
    no: ['Напиши функцию, которая уменьшает изображения', 'Переименуй все изображения в папке', 'Опиши, что ты видишь на этом изображении', 'Построй график загрузки CPU',
      'Напиши подписи к этим фото', 'Дай идеи для логотипа', 'Убедись, что логотип по центру', 'Проверь, почему картинка не загружается'],
    edit: ['Преврати это фото в карандашный рисунок', 'Убери фон', 'Измени цвет машины на красный', 'Добавь собаке солнечные очки'],
    followUp: ['измени небо на закат', 'добавь маленькую лодку на озеро', 'преврати это в акварель', 'измени дракона на зелёного'],
    work: ['теперь запусти тесты', 'сделай коммит', 'что ты изменил в парсере?', 'исправь ошибки линтера']
  },
  tr: {
    yes: ['Sisli bir ormanda bir tilki resmi oluştur', 'Bana bir ejderha çiz', 'Tane kafesi için bir logo tasarla', 'Sakin bir göl ile duvar kağıdı oluştur',
      'Bir yapılacaklar uygulaması için ikon tasarla', 'Yaşlı bir denizcinin portresini çiz', 'Caz gecesi için bir afiş oluştur', 'Fütüristik bir şehir görseli oluştur'],
    no: ['Görselleri küçülten bir fonksiyon yaz', 'Klasördeki tüm resimleri yeniden adlandır', 'Bu resimde ne gördüğünü açıkla', 'CPU kullanımının grafiğini çiz',
      'Bu fotoğraflar için açıklamalar yaz', 'Bir logo için fikirler ver', 'Logonun ortalandığından emin ol', 'Resmin neden yüklenmediğini kontrol et'],
    edit: ['Bu fotoğrafı kara kalem çizime dönüştür', 'Arka planı kaldır', 'Arabanın rengini kırmızıya değiştir', 'Köpeğe güneş gözlüğü ekle'],
    followUp: ['gökyüzünü gün batımına değiştir', 'göle küçük bir tekne ekle', 'ejderhayı yeşile değiştir', 'suluboya resme dönüştür'],
    work: ['şimdi testleri çalıştır', 'commit at lütfen', 'parserda neyi değiştirdin?', 'lint hatalarını düzelt']
  },
  vi: {
    yes: ['Tạo một hình ảnh con cáo trong rừng sương mù', 'Vẽ cho tôi một con rồng', 'Thiết kế một logo cho quán cà phê Hạt', 'Tạo hình nền với một hồ nước yên tĩnh',
      'Thiết kế biểu tượng cho ứng dụng việc cần làm', 'Vẽ chân dung một thủy thủ già', 'Tạo áp phích cho đêm nhạc jazz', 'Tạo một bức tranh thành phố tương lai'],
    no: ['Viết một hàm thay đổi kích thước hình ảnh', 'Đổi tên tất cả hình ảnh trong thư mục', 'Mô tả những gì bạn thấy trong hình này', 'Vẽ biểu đồ mức sử dụng CPU',
      'Viết chú thích cho những ảnh này', 'Cho tôi ý tưởng về logo', 'Đảm bảo logo nằm giữa', 'Kiểm tra tại sao ảnh không tải được'],
    edit: ['Biến ảnh này thành tranh bút chì', 'Đổi màu xe thành màu đỏ', 'Thêm kính râm cho con chó', 'Chỉnh sửa ảnh này cho sáng hơn'],
    followUp: ['đổi bầu trời thành hoàng hôn', 'thêm một chiếc thuyền nhỏ trên hồ', 'biến con rồng thành màu xanh', 'chỉnh sửa cho sáng hơn'],
    work: ['bây giờ chạy test', 'commit giúp tôi', 'bạn đã đổi gì trong parser?', 'sửa lỗi lint']
  },
  'zh-CN': {
    yes: ['生成一张雾林中狐狸的图片', '帮我画一条龙', '为豆子咖啡店设计一个标志', '生成一张平静湖泊的壁纸',
      '为待办应用设计一个图标', '画一幅老水手的肖像', '为爵士之夜制作一张海报', '生成一张未来城市的插画'],
    no: ['写一个缩放图片的函数', '把文件夹里的图片都重命名', '描述这张图片里有什么', '画一个CPU使用率的图表',
      '为这些照片写说明', '给我一些标志的想法', '确保标志居中', '检查图片为什么加载不出来'],
    edit: ['把这张照片变成铅笔素描', '去掉背景', '把车的颜色改成红色', '给狗加上墨镜'],
    followUp: ['把天空改成日落', '在湖上加一条小船', '把龙变成绿色', '改成水彩风格'],
    work: ['现在运行测试', '帮我提交一下', '你在解析器里改了什么？', '修复lint错误']
  },
  'zh-TW': {
    yes: ['生成一張霧林中狐狸的圖片', '幫我畫一條龍', '為豆子咖啡店設計一個標誌', '生成一張平靜湖泊的桌布',
      '為待辦應用程式設計一個圖示', '畫一幅老水手的肖像', '為爵士之夜製作一張海報', '生成一張未來城市的插畫'],
    no: ['寫一個縮放圖片的函式', '把資料夾裡的圖片都重新命名', '描述這張圖片裡有什麼', '畫一個CPU使用率的圖表',
      '為這些照片寫說明', '給我一些標誌的想法', '確保標誌置中', '檢查圖片為什麼載入不出來'],
    edit: ['把這張照片變成鉛筆素描', '去掉背景', '把車的顏色改成紅色', '給狗加上墨鏡'],
    followUp: ['把天空改成日落', '在湖上加一條小船', '把龍變成綠色', '改成水彩風格'],
    work: ['現在執行測試', '幫我提交一下', '你在解析器裡改了什麼？', '修正lint錯誤']
  },
  ja: {
    yes: ['霧の森にいるキツネの画像を生成して', 'ドラゴンを描いて', 'カフェ「豆」のロゴを作って', '静かな湖の壁紙を作成して',
      'タスクアプリのアイコンをデザインして', '年老いた船乗りの絵を描いて', 'ジャズナイトのポスターを作って', '未来都市のイラストを生成して'],
    no: ['画像をリサイズする関数を書いて', 'フォルダ内の画像の名前を全部変えて', 'この画像に何が写っているか説明して', 'CPU使用率のグラフを作って',
      'これらの写真のキャプションを書いて', 'ロゴのアイデアをちょうだい', 'ロゴが中央にあるか確認して', '画像が読み込まれない理由を調べて'],
    edit: ['この写真を鉛筆画にして', '背景を消して', '車の色を赤に変えて', '犬にサングラスを追加して'],
    followUp: ['空を夕焼けに変えて', '湖に小さな船を追加して', 'ドラゴンを緑にして', '水彩画風にして'],
    work: ['テストを実行して', 'コミットして', 'パーサーで何を変えた？', 'lintエラーを直して']
  },
  ko: {
    yes: ['안개 낀 숲속 여우 이미지를 만들어줘', '용을 그려줘', '카페 콩을 위한 로고를 만들어줘', '고요한 호수 배경화면을 생성해줘',
      '할 일 앱 아이콘을 디자인해줘', '늙은 선원의 초상화를 그려줘', '재즈의 밤 포스터를 만들어줘', '미래 도시 일러스트를 생성해줘'],
    no: ['이미지 크기를 조정하는 함수를 작성해줘', '폴더 안의 이미지 이름을 모두 바꿔줘', '이 이미지에 무엇이 있는지 설명해줘', 'CPU 사용량 차트를 만들어줘',
      '이 사진들의 캡션을 써줘', '로고 아이디어를 줘', '로고가 가운데에 있는지 확인해줘', '이미지가 로드되지 않는 이유를 확인해줘'],
    edit: ['이 사진을 연필 스케치로 바꿔줘', '배경 제거해줘', '자동차 색을 빨간색으로 바꿔줘', '강아지에게 선글라스를 추가해줘'],
    followUp: ['하늘을 노을로 바꿔줘', '호수에 작은 배를 추가해줘', '용을 초록색으로 바꿔줘', '수채화 스타일로 바꿔줘'],
    work: ['이제 테스트 실행해줘', '커밋해줘', '파서에서 뭘 바꿨어?', 'lint 오류 고쳐줘']
  }
};

describe.each(Object.entries(corpus))('asksForImage in %s', (_language, cases) => {
  it.each(cases.yes)('counts the request %s', text => expect(asksForImage(text)).toBe(true));
  it.each(cases.no)('leaves the look-alike %s', text => {
    expect(asksForImage(text)).toBe(false);
    expect(asksForImage(text, { afterImage: true })).toBe(false);
  });
  it.each(cases.edit)('counts the edit of an attached picture %s', text => expect(asksForImage(text, { attachedImage: true })).toBe(true));
  it.each(cases.followUp)('counts the follow-up %s after a picture', text => {
    expect(asksForImage(text, { afterImage: true })).toBe(true);
  });
  it.each(cases.work)('leaves the work follow-up %s', text => expect(asksForImage(text, { afterImage: true })).toBe(false));
});
