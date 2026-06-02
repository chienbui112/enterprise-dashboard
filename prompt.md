# Route Optimizer

# Hệ thống giao hàng cần tối ưu lộ trình cho một shipper phải đi qua 20 điểm giao hàng khác nhau trong thành phố sao cho tổng quãng đường ngắn nhất và thời gian đi là tối ưu nhất (Bài toán Người bán hàng - Traveling Salesman Problem - TSP). Đồng thời, hệ thống phải tự động chuyển đổi phương thức di chuyển (Multi-modal): Đi bộ trong ngõ nhỏ, đi xe máy trên đường lớn, hoặc đi tàu điện ngầm.

Role: Bạn là một Principal Frontend Engineer chuyên về Hệ thống thông tin địa lý (GIS) và Thuật toán tối ưu.

Nhiệm vụ: Hãy viết một component React hoàn chỉnh (TypeScript) tích hợp với MapLibre GL để giải quyết bài toán Người bán hàng (Traveling Salesman Problem - TSP) cho 20 điểm giao hàng được chọn ngẫu nhiên trên bản đồ.

Yêu cầu kiến trúc và kỹ thuật bắt buộc:

1. Giao diện: Gồm 1 MapLibre Container và 1 Control Panel hiển thị danh sách các điểm theo thứ tự tối ưu và tổng quãng đường ước tính.
2. Xử lý bất đồng bộ (Web Worker): Tuyệt đối không giải thuật TSP trên Main Thread. Hãy viết mã nguồn cho một Web Worker
   (dưới dạng một chuỗi Blob hoặc file riêng) triển khai giải thuật Tìm kiếm lân cận (Nearest Neighbor) hoặc Giải thuật di truyền (Genetic Algorithm) để tìm thứ tự đi qua 20 điểm sao cho quãng đường ngắn nhất.
3. Luồng dữ liệu:
   - Khi bấm nút "Tối ưu lộ trình", Frontend đẩy mảng 20 tọa độ xuống Web Worker.
   - Web Worker tính toán, trả về mảng index đã được sắp xếp tối ưu.
   - Trình duyệt nhận kết quả, gọi API giả lập lấy đường đi chi tiết (Polyline), và vẽ lên bản đồ bằng 'line' layer của MapLibre.
4. Quản lý State: Chỉ dùng React State cho danh sách kết quả cuối cùng đã tối ưu để render lên UI. Toàn bộ quá trình tính toán hình học lưu trong useRef.

Hãy viết code tường minh, sạch sẽ, có comment giải thích tư duy thuật toán toán học trong Worker.

# Geofence Monitor

# Ứng dụng quản lý lệnh cấm hoặc vận hành cảng biển/sân bay cần giám sát 50,000 xe tải di chuyển liên tục. Hệ thống có 2,000 vùng cấm (Geofences) có hình thù phức tạp (Polygon lồi, lõm). Cứ mỗi khi xe tải đi vào hoặc đi ra khỏi vùng cấm, hệ thống phải phát tín hiệu cảnh báo (Alert) ngay lập tức dưới 500ms.

Role: Bạn là một Spatial Systems Engineer chuyên xử lý Big Data Spatial trên trình duyệt.

Nhiệm vụ: Hãy viết giải pháp mã nguồn (React + TypeScript + MapLibre GL + Turf.js) mô phỏng hệ thống giám sát 10,000 phương tiện di chuyển theo thời gian thực đi qua 50 vùng cấm (Geofences dạng Polygon hình thù bất kỳ).
Phát cảnh báo ngay lập tức khi xe đi VÀO hoặc ĐI RA khỏi vùng cấm.

Yêu cầu kiến trúc và kỹ thuật bắt buộc:

1. Giả lập dữ liệu: Tạo ngẫu nhiên 50 Polygon (vùng cấm) trên bản đồ Hà Nội. Giả lập 10,000 điểm (phương tiện) dịch chuyển liên tục bằng requestAnimationFrame (hoặc setInterval tốc độ cao).
2. Tối ưu hóa thuật toán 2 tầng (Two-Phase Filtering):
   - Tầng 1 (Bounding Box / R-Tree đơn giản): Chỉ những xe nào nằm trong bounding box của Polygon mới được đưa vào Tầng 2. Các xe ở quá xa sẽ bị loại bỏ ngay lập tức bằng phép tính đại số đơn giản ($x_{min} \le x \le x_{max}$).
   - Tầng 2 (Point-in-Polygon): Đẩy các xe vượt qua Tầng 1 vào một Web Worker sử dụng hàm booleanPointInPolygon của Turf.js để kiểm tra chính xác.
3. Quản lý trạng thái (State Tracking): Thiết kế một cơ chế cache (Sử dụng Map hoặc Object dữ liệu thô, không dùng React State) lưu trạng thái trước đó của xe: 'INSIDE' hoặc 'OUTSIDE'. Hệ thống chỉ kích hoạt sự kiện OnEnter khi trạng thái đổi từ OUTSIDE -> INSIDE và OnExit khi đổi từ INSIDE -> OUTSIDE để tránh bão log cảnh báo.
4. Hiển thị: Vẽ 10,000 xe bằng Layer 'circle' của MapLibre để tận dụng sức mạnh GPU. Những xe vi phạm vùng cấm sẽ tự động đổi sang màu đỏ.

Hãy cung cấp toàn bộ mã nguồn của Component và mã nguồn chạy trong Web Worker.

# History Playback

# Ban quản lý an toàn giao thông hoặc bảo hiểm cần một tính năng "Tua lại lịch sử" (Playback giống như xem video). Họ muốn chọn một khoảng thời gian (ví dụ từ 8h00 đến 9h00 sáng hôm qua) để xem lại chuyển động của 10,000 phương tiện. Hệ thống phải tự động phát hiện và đánh dấu các điểm mà hai xe có khoảng cách quá gần nhau (< 2 mét) nguy cơ xảy ra va chạm.

Role: Bạn là một Senior WebGIS Developer chuyên sâu về Data Visualization và bài toán Chuỗi thời gian (Time-series Spatial Data).

Nhiệm vụ: Hãy viết một ứng dụng React (TypeScript) + MapLibre GL cho phép tua lại lịch sử di chuyển (Playback) của 5,000 phương tiện trong một khung thời gian giả lập dài 5 phút (300 giây). Đồng thời tự động phát hiện các cặp xe có khoảng cách gần nhau dưới 5 mét (nguy cơ va chạm).

Yêu cầu kiến trúc và kỹ thuật bắt buộc:

1. Cấu trúc dữ liệu Không-Thời gian: Hãy thiết kế cấu trúc dữ liệu tối ưu để lưu lịch sử. Thay vì lưu mảng lồng nhau phức tạp làm tràn RAM, hãy tổ chức dữ liệu theo dạng phẳng (Flattened) hoặc cấu trúc mảng số tuyến tính (ví dụ: Map với key là `timestamp`, value là một mảng phẳng các tọa độ `[id, lng, lat]`) để tăng tốc độ truy xuất đạt O(1) khi tua timeline.
2. Thanh trượt Timeline (Playback Controller): Thiết kế một thanh trượt Slider đại diện cho thời gian từ giây 0 đến giây 300. Khi người dùng bấm Play, một hàm loop chạy liên tục, tăng timestamp và cập nhật vị trí của 5,000 xe lên bản đồ thông qua nguồn dữ liệu MapLibre `source.setData()`. Luồng dữ liệu chạy mượt mà ở mức 60 FPS.
3. Phân tích va chạm (Proximity Detection): Tại mỗi mốc giây (timestamp), hệ thống phải quét nhanh xem có cặp xe nào cách nhau dưới 5 mét hay không. Sử dụng thuật toán tối ưu (như chia lưới không gian - Spatial Grid/Bucketing hoặc sắp xếp theo trục - Sweep and Prune) để tránh vòng lặp lồng nhau $O(N^2)$.
4. Giao diện: Hiển thị bản đồ với các xe đang di chuyển. Nếu có 2 xe quá gần nhau, hiển thị một vòng tròn cảnh báo màu vàng/đỏ tại tọa độ đó và đẩy dòng thông báo vào một danh sách "Cảnh báo va chạm gần".

Hãy viết mã nguồn hoàn chỉnh, tập trung tối ưu bộ nhớ RAM và hiệu năng render của GPU trên bản đồ.
