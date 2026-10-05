import { describe, expect, it } from 'vitest';
import { asksForImage } from '../src/main/session/image-request.js';

describe('asksForImage', () => {
  it.each([
    'Create an image of a red fox in the snow.',
    'Please generate a picture of a lighthouse at night',
    'can you make me a logo for my bakery?',
    'Draw a cat wearing a hat',
    'draw cats',
    'Design a poster for our summer festival',
    'I need an illustration showing two hands shaking',
    'Give me a wallpaper with mountains, 16:9',
    'Make 3 icons for a weather app',
    'Generate a photorealistic photo of a coffee cup',
    'An image of a robot reading a book, please.',
    'Create a small watercolor painting of a harbor and save it to /workspace/harbor.png',
    'create a sticker of a happy avocado',
    'Erstelle ein Bild von einem Hund am Strand',
    'Zeichne einen Drachen',
    'Mach mir ein Logo für meinen Laden',
    'Generiere ein Hintergrundbild mit Bergen',
    'Crea una imagen de un gato astronauta',
    'Dibuja un perro',
    'Diseña un logotipo para mi empresa',
    'Crée une image d’un chat sur la lune',
    'Dessine un château',
    'Génère une affiche pour un concert',
    'Crie uma imagem de um pôr do sol na praia',
    'Desenhe um gato',
    'Faça um logo para minha loja',
    'Создай изображение кота в космосе',
    'Нарисуй собаку',
    'Сгенерируй картинку с горами',
    'Bir kedi resmi oluştur',
    'Bir köpek çiz',
    'Tạo một hình ảnh con mèo trên mặt trăng',
    'Vẽ một con chó',
    '帮我画一只猫',
    '生成一张海边日落的图片',
    '设计一个咖啡店的标志',
    '畫一張山景的海報',
    '猫のイラストを描いて',
    '夕焼けの画像を生成して',
    '고양이 그림을 그려줘',
    '바다 이미지 만들어줘',
    '/clear-writing Create an image of a quiet library',
    'Create a logo and save it to the project folder',
    'Erstelle ein Bild von einer Katze und speichere es im Ordner',
    'Draw a cartoon of a python snake',
    'Generate an image based on this screenshot'
  ])('counts %s', text => {
    expect(asksForImage(text)).toBe(true);
  });

  it.each([
    'Fix the failing test in src/app.ts',
    'Run npm test and tell me what fails',
    'What is in this image?',
    'Describe the picture I attached',
    'Resize the image in /workspace/logo.png to 64x64',
    'Convert all PNG images in the folder to webp',
    'Compress these photos',
    'Write a Python script that draws a mandelbrot image',
    'Create an Image component in React that lazy-loads',
    'Generate the SVG code for a logo',
    'Draw a diagram of the system architecture',
    'Make a chart of the monthly revenue',
    'Make sure the image loads before the page renders',
    'Take a screenshot of the settings page',
    'Explain how image generation works in ChatGPT',
    'Add the logo to the header of index.html',
    'Erstelle ein Skript, das alle Bilder umbenennt',
    'Beschreibe dieses Bild',
    'Crea una función que redimensione imágenes',
    'Écris une commande pour compresser les images',
    'Напиши скрипт, который рисует график',
    '写一个生成图片的脚本',
    'この画像を説明して',
    '이미지 압축하는 코드 작성해줘',
    'Summarize this document',
    'Thanks!',
    '```js\nconst image = createImage();\n```',
    'Generate thumbnails for all videos in the folder',
    'Make an image for each file in the assets directory',
    'Generate an image description for each photo',
    'Write alt text for the hero image',
    'Give me ideas for a logo',
    'Generate 5 image prompts for Midjourney',
    'Erstelle eine Bildbeschreibung für jedes Foto',
    'Make a list of the images we use on the site'
  ])('leaves %s with the mention', text => {
    expect(asksForImage(text)).toBe(false);
  });

  it('reads a short follow-up after ChatGPT made an image as an edit, but not work or files', () => {
    for (const text of ['make it brighter', 'Change the background to blue', 'Add a hat to the cat', 'mach es dunkler', 'cámbialo a rojo', '把背景改成蓝色'])
      expect(asksForImage(text, { afterImage: true }), text).toBe(true);
    for (const text of ['now run the tests', 'fix the build', 'Add a test for the parser', 'save it to the folder', 'thanks, that works'])
      expect(asksForImage(text, { afterImage: true }), text).toBe(false);
    // Without an image just made, the same words are no image request.
    expect(asksForImage('make it brighter')).toBe(false);
    expect(asksForImage('Change the background to blue')).toBe(false);
  });

  it('reads an edit of an attached image as an image request, and handling it as file work as not', () => {
    expect(asksForImage('Turn this photo into a watercolor painting', { attachedImage: true })).toBe(true);
    expect(asksForImage('Remove the background', { attachedImage: true })).toBe(true);
    expect(asksForImage('Verwandle das Foto in ein Ölgemälde', { attachedImage: true })).toBe(true);
    expect(asksForImage('Convert this to webp', { attachedImage: true })).toBe(false);
    expect(asksForImage('What does this screenshot show?', { attachedImage: true })).toBe(false);
  });
});
