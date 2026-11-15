# FrameSound — Fotoğraf + Ses → MP4

Tek fotoğraf ile ses dosyasını birleştirerek MP4 üretir. 1:1, 9:16, 16:9 ve özel çözünürlük; kalite (%), sıkıştırma hedefi (%), sonuçta gerçek MB; 60 saniyelik story parçaları ve tek ZIP indirme.

## Kurulum
- Node.js 20 veya üzeri kurun.
- `npm install`
- `npm start`
- `http://localhost:3000` adresini açın.

FFmpeg ve FFprobe paketlerle birlikte gelir (desteklenen işletim sistemlerinde). Üretim ortamında disk, CPU ve bellek kullanımını sınırlandırın. `PORT`, `JOBS_DIR`, `MAX_UPLOAD_MB` (varsayılan 100), `MAX_DURATION_SECONDS` (varsayılan 3600) ve `MAX_CONCURRENT_JOBS` (varsayılan 2) ortam değişkenlerini kullanabilirsiniz.

## Notlar
- Çıktı H.264 / AAC MP4, video arka planı siyah olacak biçimde *contain* ölçekleme ile oluşturulur; fotoğraf kesilmez.
- 60 saniyelik dilimler hassas zaman aralıklarıyla yeniden kodlanır; son dilim kalanı içerir. Gerçek sürelerde küçük codec sapmaları olabilir.
- Tahmini MB, tahmini bit hızından elde edilir; sabit fotoğraflı videolarda gerçek boyut daha küçük olabilir.
- Geçici çıktı dosyaları yaklaşık 2 saat içinde temizlenir. Dosyalar sunucuya yüklenir, kalıcı depolanmaz.
- Yüklemeler kimlik doğrulamasızdır: internete açık üretimde hız sınırlaması, disk kotası, işlem kuyruğu ve kimlik doğrulama ekleyin.
- Uygulama sunucu üzerinde FFmpeg çalıştırır; yalnızca statik hosting üzerinde çalışmaz.
