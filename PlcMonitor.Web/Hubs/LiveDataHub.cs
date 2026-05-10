using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;

namespace PlcMonitor.Web.Hubs
{
    /// <summary>
    /// SignalR хаб — живые данные из ПЛК в браузер.
    /// Браузер подключается и получает обновления тегов в реальном времени.
    /// </summary>
    public class LiveDataHub : Hub
    {
        // Браузер подписывается на группу мониторинга
        public async Task SubscribeToGroup(string groupId)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, groupId);
        }

        public async Task UnsubscribeFromGroup(string groupId)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, groupId);
        }
    }

    // Расширение — отправка данных из других сервисов
    public static class LiveDataHubExtensions
    {
        // Отправить обновление тега всем подписчикам
        public static async Task SendTagUpdate(
            IHubContext<LiveDataHub> hub,
            string groupId,
            TagValueMessage message)
        {
            await hub.Clients.Group(groupId).SendAsync("TagUpdate", message);
        }

        // Отправить статус подключения к ПЛК
        public static async Task SendPlcStatus(
            IHubContext<LiveDataHub> hub,
            PlcStatusMessage message)
        {
            await hub.Clients.All.SendAsync("PlcStatus", message);
        }
    }

    // Сообщение — значение тега
    public class TagValueMessage
    {
        public string TagId { get; set; }
        public string SymbolicPath { get; set; }
        public object Value { get; set; }
        public long TimestampMs { get; set; } // Unix ms
        public bool IsValid { get; set; }
    }

    // Сообщение — статус ПЛК
    public class PlcStatusMessage
    {
        public string PlcSourceId { get; set; }
        public string PlcName { get; set; }
        public bool IsConnected { get; set; }
        public string Error { get; set; }
    }
}
