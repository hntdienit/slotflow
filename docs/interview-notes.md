# Ghi chú phỏng vấn: SlotFlow

Tóm tắt từng quyết định, câu hỏi thường gặp và cách trả lời. Mọi số liệu lấy từ repo (xem `docs/benchmarks.md`,
`docs/adr/`). Khi nói, anh nên nói đúng những gì dự án làm được và nêu rõ những gì chưa làm (mục "Điểm yếu").

## Câu chuyện 60 giây

SlotFlow là nền tảng đặt lịch đa chi nhánh (dữ liệu mẫu: phòng khám). Em tập trung vào bốn việc khó của loại hệ thống
này: không bao giờ đặt trùng lịch khi nhiều người đặt cùng lúc, cô lập dữ liệu giữa các tenant, xử lý múi giờ và DST, và
cho AI tham gia đặt lịch mà không cho AI quyền làm gì nguy hiểm. Mọi thứ có test: 100 request cùng một giờ chỉ đúng 1
thành công, tải k6 hơn 9.000 request tranh chấp không tạo ra lịch chồng nào.

## Quyết định chính và câu hỏi hay gặp

### 1. Vì sao dùng exclusion constraint thay vì khóa ở tầng ứng dụng? (ADR-002)

- Khóa ở ứng dụng (Redis lock, `SELECT ... FOR UPDATE` trên nhiều dòng) chỉ đúng khi mọi đường ghi đều đi qua nó và khóa
  không bao giờ mất. Redis mất dữ liệu hay hai instance chạy song song là hết đúng.
- Constraint `EXCLUDE USING gist (resource_id WITH =, time_range WITH &&) WHERE status IN ('held','confirmed')` đặt luật
  ngay trong dữ liệu: database từ chối bản ghi chồng lấn, bất kể ai ghi. Ứng dụng chỉ việc bắt lỗi và trả 409.
- Redis trong dự án chỉ là cache của availability (60 giây, có version theo tenant/chi nhánh). Mất Redis thì chậm hơn
  chứ không sai.

### 2. Đặt nhiều tài nguyên một lúc (nhân viên + phòng) mà không deadlock

- Mỗi lần đặt ghi booking và mọi dòng `booking_resources` trong một transaction, chèn theo thứ tự `resource_id` tăng dần.
  Hai transaction cùng cần A và B đều lấy A trước rồi B nên không chờ vòng tròn.
- Test: 2 nhân viên × 2 phòng, 100 request song song, đúng 2 thành công, nhân viên và phòng khác nhau, không deadlock.

### 3. Hold có hạn mà constraint không dùng được `now()`

- Constraint chỉ so sánh khoảng thời gian, không biết "hết hạn". Nên hold hết hạn phải chuyển trạng thái sang `expired`
  (và dòng resource sang `expired`) để thoát khỏi điều kiện `WHERE` của constraint.
- Hai lớp dọn: ngay trong transaction đặt lịch (nếu thấy hold hết hạn đang cản thì dọn rồi thử lại) và worker sweeper.
  Nhờ vậy slot không kẹt dù worker chết.

### 4. Idempotency

- `Idempotency-Key` + SHA-256 của nội dung request lưu cùng booking, có unique index. Gửi lại cùng key trả đúng booking cũ;
  cùng key nhưng nội dung khác bị từ chối. Hai request trùng đến cùng lúc: một thắng ở unique index, bên thua đọc lại bản ghi.
- Trợ lý AI dùng key `ai:<conversation>:<startAt>` nên "có" bấm hai lần không đặt đôi.

### 5. Múi giờ và DST (ADR-004)

- Giờ làm việc lưu theo giờ địa phương của chi nhánh, không lưu UTC cố định; engine đổi sang instant khi tính.
- Ngày chuyển giờ: giờ không tồn tại bị dời về sau, giờ lặp lấy lần đầu. Có test riêng cho ngày DST và chi nhánh khác múi
  giờ với khách (Hà Nội so với Sydney).

### 6. Vì sao outbox + SQS thay vì gọi trực tiếp? (ADR-006)

- Gửi email/nhắc lịch trong request làm request chậm và có thể mất khi crash giữa chừng. Outbox ghi sự kiện cùng transaction
  với booking: hoặc cả hai có, hoặc không có gì.
- Relay gửi SQS trước rồi mới đánh dấu đã gửi, nên tệ nhất là gửi trùng, không bao giờ mất. Consumer dựng lại việc cần làm
  từ trạng thái hiện tại của booking, nên sự kiện trùng hoặc sai thứ tự vẫn đúng (idempotent).
- Retry/backoff mũ bằng visibility timeout, sau 5 lần chuyển vào DLQ. Lỗi vĩnh viễn của một event không chặn event khác.
- Nhắc lịch trễ: SQS chỉ delay tối đa 15 phút nên worker đưa thông báo vào queue khi còn dưới 15 phút, với delay đúng phần còn lại.
- Trade-off BullMQ và SQS: BullMQ đơn giản, chạy trên Redis (mất Redis là mất việc nếu không bật persistence). SQS bền hơn,
  scale worker ngang dễ, nhưng thêm phụ thuộc AWS (em dùng LocalStack khi chạy local). Em đã cố dùng EventBridge Scheduler
  nhưng LocalStack 4.12 không kích hoạt schedule, nên chọn cách trên; đây là lý do kỹ thuật, không phải sở thích.

### 7. Waitlist công bằng (ADR-007)

- Lời mời là một hold thật (qua đúng `BookingService.place`), nên constraint bảo vệ slot đang được mời như mọi booking.
- Worker chỉ kích hoạt ("slot này vừa trống"), API quyết định bằng cách xem availability thật, nên gọi lặp hay song song đều
  an toàn (12 lần release song song chỉ ra 1 lời mời). FIFO theo thời điểm đăng ký; từ chối hoặc để hết hạn thì giữ chỗ cho khung giờ khác.

### 8. Làm sao cho AI đặt lịch mà an toàn? (ADR-008)

- Model chỉ trích xuất tham số (Zod, id phải thuộc catalog của tenant). Câu trả lời là mẫu cố định. Việc tìm slot và đặt lịch
  đi qua đúng service như web.
- Xác nhận là trạng thái trên server (bảng `assistant_conversations`): chỉ đặt khi đang chờ xác nhận và người dùng trả lời "có".
  Prompt injection tệ nhất cũng chỉ làm ra một lượt tìm kiếm khác, không đặt/hủy/đọc dữ liệu người khác.
- Đo độ chính xác: `pnpm eval`. Nói thật: bộ 51 câu là bộ hồi quy của mock (tuned), bộ 16 câu held-out lần đầu 13/16 = 81%, sau
  khi sửa là 16/16 nên cũng đã bị tune một phần. Model thật chưa đo vì chưa có API key.
- Kiểm soát chi phí LLM: mặc định model nhỏ (haiku), giới hạn 500 ký tự mỗi tin, 20 tin/phút/khách, một tool call, mock cho CI.
- E2E bắt được 2 lỗi thật của trợ lý mà test tích hợp bỏ sót: chỉ đưa 1 lựa chọn khi hỏi một ngày, và trả lời "2" làm câu trả lời
  chuyển sang tiếng Anh. Đây là ví dụ tốt về giá trị của E2E.

### 9. Phân quyền (ADR-009)

- JWT HS256 tự viết trên `node:crypto` (khoảng 40 dòng, thuật toán cố định ở phía verify, không đọc từ token).
- Một bảng luật (method + path → role) trong guard toàn cục, route không có trong bảng thì từ chối. Kiểm tra theo dòng (khách chỉ
  thấy booking của mình, manager chỉ chi nhánh được giao) nằm ở controller; đối tượng của người khác trả 404 để không dò được id.
- Cô lập tenant không phụ thuộc phần này: RLS của Postgres vẫn là lớp cuối.

### 10. Vì sao modular monolith? (ADR-001)

- Một nhóm nhỏ, dữ liệu gắn chặt (đặt lịch, tài nguyên, waitlist cùng transaction). Tách microservice sẽ biến transaction
  thành giao dịch phân tán mà chưa có lợi ích. Ranh giới module rõ để tách sau nếu cần; worker đã là tiến trình riêng.

## Điểm yếu (nói trước, đừng để bị hỏi)

- Dependency còn advisory (multer, body-parser, zod 3.x qua NestJS 10): kế hoạch nâng NestJS 11 + zod 4. Chi tiết ở `docs/security-review.md`.
- `AUTH_MODE=dev` là mặc định cho dễ chạy; production phải đặt `jwt`. Token chưa thu hồi được, rate limit nằm trong bộ nhớ.
- Chưa có trang giám sát/thông báo, chưa kéo thả đổi lịch, chưa có đăng ký/đặt lại mật khẩu.
- Benchmark chạy một máy 2 vCPU chung với k6, Postgres, Redis; không phải số năng lực thực.
- Môi trường dựng không có Docker nên `docker compose up` chưa được chạy thử trực tiếp (test chạy trên Postgres, Redis, LocalStack thật).
- Một lần chạy toàn bộ test có 1 test đồng thời (100 request, 2 nhân viên × 2 phòng) thất bại do máy quá tải (chạy lại thì xanh, và
  chạy riêng thì ổn định); đúng đắn không bị ảnh hưởng (không có đặt trùng) nhưng số lượng thành công phụ thuộc tải.

## Làm việc với AI (để khớp phần portfolio)

- Dự án được viết cùng một trợ lý AI. Cách kiểm soát: mọi thay đổi qua nhánh + pull request, test tự động (unit, tích hợp trên
  Postgres thật, E2E bằng Chrome thật, k6), lint và typecheck trong CI; kết quả đo được ghi lại kèm giới hạn. Khi test sai, tìm nguyên
  nhân thay vì sửa cho khớp (ví dụ: nhãn sai của chính người viết bộ held-out; lỗi chỉ-1-lựa-chọn do E2E phát hiện).
- Anh nên tự đọc và chạy được các phần: constraint và transaction đặt lịch (`booking.service.ts`), engine availability
  (`packages/core`), guard phân quyền, và luồng xác nhận của trợ lý. Đó là những chỗ người phỏng vấn sẽ hỏi sâu.
